const D = JSON.parse(document.getElementById('data').textContent);
// -- edition state --
let ACTIVE_EDITION = D.currentEdition || 11;
const API = '/api';
const TEAM_PIN = '1719';

// Sanitise strings for safe use in inline event handlers
function safeAttr(str) {
  return String(str).replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
 // team-wide PIN for member writes
let attendanceData = {};

// -- approved submissions merged into events --
async function loadApprovedSubmissions() {
  try {
    // load approved result submissions
    const res = await fetch('/api/submissions');
    const ct = res.headers.get('content-type') || '';
    if (res.ok && ct.includes('application/json')) {
      const data = await res.json();
      if (data.submissions && data.submissions.length) {
        data.submissions.forEach(sub => {
          let ev = D.events.find(e =>
            e.name.toLowerCase() === sub.event_name.toLowerCase() &&
            e.format === sub.event_format
          );
          if (!ev) {
            ev = {
              name: sub.event_name,
              date: new Date(sub.submitted_at).toLocaleDateString('en-GB', { month: 'short', year: 'numeric' }),
              format: sub.event_format,
              edition: ACTIVE_EDITION,
              totalPlayers: sub.total_players || 0,
              bcpUrl: '',
              results: [],
              _fromSubmission: true
            };
            D.events.push(ev);
          }
          const exists = ev.results.some(r => r.player === sub.player_name);
          if (!exists) {
            ev.results.push({
              player: sub.player_name,
              faction: sub.faction,
              placing: sub.place || 0,
              w: sub.wins || 0,
              l: sub.losses || 0,
              d: sub.draws || 0,
              subteam: sub.subteam || null,
              _fromSubmission: true
            });
          }
        });
      }
    }
  } catch(e) {
    console.warn('Could not load approved submissions:', e);
  }

  try {
    // load events added via admin form
    const evRes = await fetch('/api/events');
    const evCt = evRes.headers.get('content-type') || '';
    if (evRes.ok && evCt.includes('application/json')) {
      const evData = await evRes.json();
      if (evData.events && evData.events.length) {
        evData.events.forEach(dbEv => {
          // skip if event already exists in JSON data
          const exists = D.events.find(e =>
            e.name.toLowerCase() === dbEv.name.toLowerCase() &&
            e.format === dbEv.format
          );
          if (!exists) {
            D.events.push({
              name: dbEv.name,
              date: dbEv.event_date,
              sortDate: dbEv.sort_date,
              format: dbEv.format,
              edition: dbEv.edition || 10,
              totalPlayers: dbEv.total_players || 0,
              totalTeams: dbEv.total_teams || 0,
              bcpUrl: dbEv.bcp_url || '',
              results: (dbEv.results || []).map(r => ({
                player: r.player_name,
                faction: r.faction,
                placing: parseInt(r.place || r.placing || 0, 10),
                w: parseInt(r.wins || 0, 10),
                l: parseInt(r.losses || 0, 10),
                d: parseInt(r.draws || 0, 10),
                subteam: r.subteam || null,
                shadow: r.shadow || false,
                dropped: r.dropped || false,
                _fromDb: true
              })),
              _fromDb: true
            });
          }
        });
      }
    }
  } catch(e) {
    console.warn('Could not load db events:', e);
  }
}

async function loadPlayers() {
  try {
    const res = await fetch('/api/players');
    const ct = res.headers.get('content-type') || '';
    if (!res.ok || !ct.includes('application/json')) return;
    const data = await res.json();
    if (data.players && data.players.length) {
      // Replace D.players with DB data
      D.players = data.players.map(p => ({
        name: p.name,
        factions: p.factions || [],
        active: p.active !== false
      })).filter(p => p.active);
    }
  } catch(e) {
    console.warn('Failed to load players:', e.message);
  }
}

async function initSite() {
  // Show loading indicator immediately
  const headerMeta = document.getElementById('header-meta');
  if (headerMeta) headerMeta.innerHTML = '<span style="color:var(--muted);animation:pulse 1.2s ease-in-out infinite;">Loading season data...</span>';

  // Load players, events/submissions, attendance, and db events in parallel
  await Promise.all([
    loadPlayers(),
    loadApprovedSubmissions(),
    loadAttendance(),   // must be before rebuildStats so CoS optins render correctly
    loadDbEvents(),     // needed for calendar, countdown, and who's going
  ]);

  rebuildStats();
  buildNowPanel();
  // Show first-visit welcome nudge if member hasn't identified themselves
  if (!localStorage.getItem('pssn_member') && !localStorage.getItem('pssn_nudge_dismissed')) {
    const nudge = document.getElementById('welcome-nudge');
    if (nudge) nudge.style.display = 'block';
  }
  loadLeagueData().then(() => { leagueLoaded = true; });
  if (sessionStorage.getItem('pssn_admin_pin')) updatePendingBadge();
  // Restore My Club unlock state if returning to page in same session
  if (sessionStorage.getItem('pssn_team_unlocked') === '1') {
    const gate = document.getElementById('pin-gate');
    const form = document.getElementById('submit-form');
    if (gate) gate.style.display = 'none';
    if (form) form.style.display = 'block';
  }
}


function switchEdition(ed) {
  ACTIVE_EDITION = ed;
  invalidateEventsCache();
  clearFactionWRCache();
  document.getElementById('ed-10').style.background = ed === 10 ? 'var(--accent)' : 'transparent';
  document.getElementById('ed-10').style.color = ed === 10 ? '#fff' : 'var(--muted)';
  document.getElementById('ed-11').style.background = ed === 11 ? 'var(--accent)' : 'transparent';
  document.getElementById('ed-11').style.color = ed === 11 ? '#fff' : 'var(--muted)';
  // Update CoS section heading to reflect current edition
  const cosTitle = document.getElementById('cos-edition-label');
  if (cosTitle) cosTitle.textContent = ed === 10 ? '10th Edition' : '11th Edition';
  rebuildStats();
  renderCalendar();
  renderWhosGoing();
  buildNowPanel();
}

// Cached active events -- invalidated when edition changes
let _activeEventsCache = null;
let _activeEditionCache = null;
function getActiveEvents() {
  if (_activeEventsCache && _activeEditionCache === ACTIVE_EDITION) return _activeEventsCache;
  _activeEditionCache = ACTIVE_EDITION;
  _activeEventsCache = D.events.filter(ev => (ev.edition || 10) === ACTIVE_EDITION);
  return _activeEventsCache;
}
function invalidateEventsCache() { _activeEventsCache = null; }

// Shared pod standings calculator -- used by renderPod, buildNowPanel, openPlayerPanel, buildLeagueAdmin
function calcPodStandings(podId, players, games) {
  const podPlayers = players.filter(p => p.pod_id === podId).map(p => p.player_name);
  const podGames = games.filter(g => g.pod_id === podId);
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
  return {
    sorted: Object.values(standings).sort((a,b) => b.pts - a.pts || b.bp - a.bp),
    standings,
    podGames,
    podPlayers
  };
}

// -- leaderboard --
let activeFilter = 'Singles';
const filters = ['Singles', 'GT', 'RTT', 'Teams'];

const BAYES_WEIGHT = 10;
const PROVISIONAL_MIN_EVENTS = 2; // minimum events (not just games) to leave provisional

// Quality multiplier: log(players)/log(100) so 100p=1.0x, 24p=0.70x, 1088p=1.52x
function eventQuality(totalPlayers) {
  if (!totalPlayers || totalPlayers < 2) return 1;
  return Math.log(Math.max(totalPlayers, 2)) / Math.log(100);
}

function bayesianWinRate(s, teamAvg) {
  if (!s.qGames) return 0;
  const wr = s.qW / s.qGames;
  return (s.qGames / (s.qGames + BAYES_WEIGHT)) * wr + (BAYES_WEIGHT / (s.qGames + BAYES_WEIGHT)) * teamAvg;
}

function getTeamAvg(map) {
  const players = Object.values(map).filter(s => s.qGames > 0);
  const totalW = players.reduce((a,s) => a + s.qW, 0);
  const totalG = players.reduce((a,s) => a + s.qGames, 0);
  return totalG ? totalW / totalG : 0.5;
}

// Build stats maps with quality weighting
// Each stat object now has:
//   w/l/d/games -- raw counts for display
//   qW/qGames   -- quality-weighted values for ranking
//   events      -- set of event names attended
//   bestResult  -- { placing, total, eventName, pct }

function ensurePlayerQ(map, name, factions) {
  if (!map[name]) map[name] = {
    name, factions: new Set(factions || []),
    w: 0, l: 0, d: 0, games: 0,
    qW: 0, qGames: 0,
    events: new Set(),
    bestResult: null
  };
}

function addResultQ(s, r, quality, eventName) {
  const w = r.w;
  const l = r.shadow ? 0 : r.l;
  const d = r.shadow ? 0 : r.d;
  s.w += w; s.l += l; s.d += d;
  s.games += w + l + d;
  s.qW += (w + d * 0.5) * quality;   // draws count as half a win
  s.qGames += (w + l + d) * quality;
  s.factions.add(r.faction);
  s.events.add(eventName);
  // track best result
  if (r.placing && !r.dropped) {
    const total = r.evTotal || 1;
    const pct = r.placing / total;
    if (!s.bestResult || pct < s.bestResult.pct) {
      s.bestResult = { placing: r.placing, total, eventName, pct };
    }
  }
}

// Rebuild all stats from scratch
const singlesStats = {};
const allStats = {};
const FORMATS = ['GT','RTT','Teams','Club','Championship'];
const fmtStats = {};
FORMATS.forEach(f => { fmtStats[f] = {}; });

D.players.forEach(p => {
  ensurePlayerQ(allStats, p.name, p.factions);
  FORMATS.forEach(f => ensurePlayerQ(fmtStats[f], p.name, p.factions));
  ensurePlayerQ(singlesStats, p.name, p.factions);
});

getActiveEvents().forEach(ev => {
  const fmt = ev.format;
  const total = fmt === 'Teams' ? (ev.totalTeams || 1) : (ev.totalPlayers || 1);
  const quality = eventQuality(total);
  (ev.results || []).forEach(r => {
    if (r.dropped) return;
    const rWithTotal = { ...r, evTotal: total };
    ensurePlayerQ(allStats, r.player, []);
    if (fmt && fmtStats[fmt]) ensurePlayerQ(fmtStats[fmt], r.player, []);
    if (fmt !== 'Teams') ensurePlayerQ(singlesStats, r.player, []);
    addResultQ(allStats[r.player], rWithTotal, quality, ev.name);
    if (fmt && fmtStats[fmt]) addResultQ(fmtStats[fmt][r.player], rWithTotal, quality, ev.name);
    if (fmt !== 'Teams') addResultQ(singlesStats[r.player], rWithTotal, quality, ev.name);
  });
});

function getRanked(filter) {
  const map = filter === 'Singles' ? singlesStats : filter === 'All' ? allStats : fmtStats[filter];
  const teamAvg = getTeamAvg(map);
  return Object.values(map)
    .filter(s => s.games > 0)
    .sort((a,b) => {
      const bA = bayesianWinRate(a, teamAvg);
      const bB = bayesianWinRate(b, teamAvg);
      if (Math.abs(bB - bA) > 0.001) return bB - bA;
      return b.qW - a.qW;  // tiebreak on quality-weighted wins, not raw wins
    });
}

function renderTeamsLeaderboard() {
  const lbEl = document.getElementById('leaderboard');

  // Build subteam map from r.subteam on results -- ev.subteams doesn't exist for DB events
  const subteamMap = {};
  getActiveEvents().filter(ev => ev.format === 'Teams').forEach(ev => {
    // Group results by subteam name
    const subteamGroups = {};
    (ev.results || []).forEach(r => {
      if (!r.subteam) return;
      if (!subteamGroups[r.subteam]) subteamGroups[r.subteam] = [];
      subteamGroups[r.subteam].push(r);
    });

    Object.entries(subteamGroups).forEach(([stName, players]) => {
      // Calculate team W/L/D from individual results
      // All players in same subteam have same placing -- use first player's placing
      const placing = players[0]?.placing || 0;
      const totalW = players.reduce((a, r) => a + (r.w || 0), 0);
      const totalL = players.reduce((a, r) => a + (r.l || 0), 0);
      const totalD = players.reduce((a, r) => a + (r.d || 0), 0);
      // Team record = individual game totals (each player plays separately)
      const stMeta = { name: stName, placing, w: totalW, l: totalL, d: totalD };

      if (!subteamMap[stName]) subteamMap[stName] = {
        name: stName, events: [], bestPlacing: Infinity,
        totalW: 0, totalL: 0, totalD: 0, totalGames: 0
      };
      subteamMap[stName].events.push({ ev, st: stMeta });
      subteamMap[stName].totalW += totalW;
      subteamMap[stName].totalL += totalL;
      subteamMap[stName].totalD += totalD;
      subteamMap[stName].totalGames += totalW + totalL + totalD;
      const pct = ev.totalTeams ? placing / ev.totalTeams : 1;
      if (pct < subteamMap[stName].bestPlacing) subteamMap[stName].bestPlacing = pct;
    });
  });

  const ranked = Object.values(subteamMap).sort((a, b) => a.bestPlacing - b.bestPlacing);
  if (!ranked.length) {
    lbEl.innerHTML = `<div style="padding:1.5rem;color:var(--muted);font-size:0.85rem;">No teams results yet.</div>`;
    return;
  }

  lbEl.innerHTML = ranked.map((st, i) => {
    const wr = st.totalGames ? Math.round((st.totalW / st.totalGames) * 100) : 0;
    const wrColor = wr >= 60 ? '#ff6a00' : wr >= 40 ? 'var(--text)' : 'var(--loss)';
    const topCls = i < 3 ? ' top3' : '';
    const stId = 'st-lb-' + st.name.replace(/[^a-z0-9]/gi, '-').toLowerCase();

    // per-event blocks for this subteam
    const eventBlocks = st.events.map(({ ev, st: stMeta }, ei) => {
      const evId = stId + '-ev-' + ei;
      const players = ev.results.filter(r => r.subteam === st.name);

      // player rows -- each clickable to show their career teams total
      const playerRows = players.map((r, pi) => {
        const playerId = evId + '-p-' + pi;

        // career teams total for this player
        const careerW = getActiveEvents().filter(e => e.format === 'Teams')
          .flatMap(e => e.results)
          .filter(x => x.player === r.player)
          .reduce((a, x) => ({ w: a.w+x.w, l: a.l+x.l, d: a.d+x.d, g: a.g+x.w+x.l+x.d }), { w:0, l:0, d:0, g:0 });
        const careerWr = careerW.g ? Math.round((careerW.w / careerW.g) * 100) : 0;

        // all teams events for this player
        const allTeamsEvents = getActiveEvents().filter(e => e.format === 'Teams' && e.results.some(x => x.player === r.player));

        const evDetailRows = allTeamsEvents.map(te => {
          const tr = te.results.find(x => x.player === r.player);
          if (!tr) return '';
          return `<tr style="background:var(--bg);">
            <td style="padding-left:4rem;font-size:0.75rem;color:var(--muted);">${te.name}</td>
            <td style="font-size:0.75rem;color:var(--muted);">${tr.subteam}</td>
            <td style="font-size:0.75rem;color:var(--muted);">${tr.faction}</td>
            <td style="font-size:0.75rem;color:var(--muted);">${te.date}</td>
            <td style="text-align:right;">
              <div style="display:flex;gap:3px;justify-content:flex-end;">
                <span class="rec-badge rec-w">${tr.w}W</span>
                <span class="rec-badge rec-l">${tr.l}L</span>
                ${tr.d > 0 ? `<span class="rec-badge rec-d">${tr.d}D</span>` : ''}
              </div>
            </td>
          </tr>`;
        }).join('');

        const careerSummaryRow = `<tr style="background:var(--surface2);">
          <td colspan="4" style="padding-left:4rem;font-size:0.72rem;font-weight:500;color:var(--muted);letter-spacing:0.06em;text-transform:uppercase;">Teams career total</td>
          <td style="text-align:right;">
            <div style="display:flex;gap:3px;justify-content:flex-end;align-items:center;">
              <span class="rec-badge rec-w">${careerW.w}W</span>
              <span class="rec-badge rec-l">${careerW.l}L</span>
              ${careerW.d > 0 ? `<span class="rec-badge rec-d">${careerW.d}D</span>` : ''}
              <span style="font-size:0.72rem;color:${careerWr >= 60 ? '#ff6a00' : 'var(--muted)'};margin-left:6px;">${careerWr}%</span>
            </div>
          </td>
        </tr>`;

        return `
          <tr onclick="toggleLb('${playerId}')" style="cursor:pointer;border-top:1px solid #222;" onmouseover="this.style.background='rgba(255,255,255,0.03)'" onmouseout="this.style.background='transparent'">
            <td style="padding-left:3rem;font-size:0.82rem;color:var(--text);">${r.player}</td>
            <td style="font-size:0.78rem;color:var(--muted);">${r.faction}</td>
            <td colspan="2" style="font-size:0.72rem;color:var(--muted);">click for career</td>
            <td style="text-align:right;">
              <div style="display:flex;gap:3px;justify-content:flex-end;align-items:center;">
                <span class="rec-badge rec-w">${r.w}W</span>
                <span class="rec-badge rec-l">${r.l}L</span>
                ${r.d > 0 ? `<span class="rec-badge rec-d">${r.d}D</span>` : ''}
                <span id="${playerId}-arrow" style="color:var(--muted);font-size:0.7rem;margin-left:6px;transition:transform 0.2s;">▼</span>
              </div>
            </td>
          </tr>
          <tr id="${playerId}" style="display:none;">
            <td colspan="5" style="padding:0;">
              <table style="width:100%;border-collapse:collapse;">
                <thead><tr>
                  <th style="padding-left:4rem;font-size:0.62rem;letter-spacing:0.1em;text-transform:uppercase;color:var(--muted);padding-top:6px;padding-bottom:6px;">Event</th>
                  <th style="font-size:0.62rem;letter-spacing:0.1em;text-transform:uppercase;color:var(--muted);">Sub-team</th>
                  <th style="font-size:0.62rem;letter-spacing:0.1em;text-transform:uppercase;color:var(--muted);">Faction</th>
                  <th style="font-size:0.62rem;letter-spacing:0.1em;text-transform:uppercase;color:var(--muted);">Date</th>
                  <th style="text-align:right;font-size:0.62rem;letter-spacing:0.1em;text-transform:uppercase;color:var(--muted);">W / L / D</th>
                </tr></thead>
                <tbody>${evDetailRows}${careerSummaryRow}</tbody>
              </table>
            </td>
          </tr>`;
      }).join('');

      const isTop = stMeta.placing <= Math.ceil(ev.totalTeams * 0.15);
      return `
        <tr onclick="toggleLb('${evId}')" style="cursor:pointer;background:var(--surface2);border-top:1px solid #2a2a2a;" onmouseover="this.style.background='#2a2a2a'" onmouseout="this.style.background='var(--surface2)'">
          <td style="padding-left:2rem;font-size:0.82rem;color:var(--text);">${ev.name}</td>
          <td style="font-size:0.78rem;color:var(--muted);">${ev.date}</td>
          <td style="display:flex;gap:4px;padding-top:10px;">
            <span class="rec-badge rec-w">${stMeta.w}W</span>
            <span class="rec-badge rec-l">${stMeta.l}L</span>
            ${stMeta.d > 0 ? `<span class="rec-badge rec-d">${stMeta.d}D</span>` : ''}
          </td>
          <td style="font-size:0.82rem;color:${isTop ? '#ff6a00' : 'var(--text)'};">${stMeta.placing} / ${ev.totalTeams}</td>
          <td style="text-align:right;"><span id="${evId}-arrow" style="color:var(--muted);font-size:0.7rem;transition:transform 0.2s;">▼</span></td>
        </tr>
        <tr id="${evId}" style="display:none;">
          <td colspan="5" style="padding:0;">
            <table style="width:100%;border-collapse:collapse;">
              <thead><tr>
                <th style="padding-left:3rem;font-size:0.62rem;letter-spacing:0.1em;text-transform:uppercase;color:var(--muted);padding-top:6px;padding-bottom:6px;">Player</th>
                <th style="font-size:0.62rem;letter-spacing:0.1em;text-transform:uppercase;color:var(--muted);">Faction</th>
                <th colspan="2" style="font-size:0.62rem;letter-spacing:0.1em;text-transform:uppercase;color:var(--muted);"></th>
                <th style="text-align:right;font-size:0.62rem;letter-spacing:0.1em;text-transform:uppercase;color:var(--muted);">W / L / D</th>
              </tr></thead>
              <tbody>${playerRows}</tbody>
            </table>
          </td>
        </tr>`;
    }).join('');

    const bestPct = Math.round((1 - st.bestPlacing) * 100);
    return `
      <div class="lb-row${topCls}" style="display:block;padding:0;cursor:pointer;" onclick="toggleLb('${stId}')">
        <div class="lb-inner" onmouseover="this.style.background='rgba(255,255,255,0.03)'" onmouseout="this.style.background='transparent'">
          <div class="lb-rank">${i + 1}</div>
          <div>
            <div class="lb-name">${st.name}</div>
            <div class="lb-faction">${st.events.length} event${st.events.length !== 1 ? 's' : ''}</div>
          </div>
          <div class="lb-record">
            <span class="rec-badge rec-w">${st.totalW}W</span>
            <span class="rec-badge rec-l">${st.totalL}L</span>
            ${st.totalD > 0 ? `<span class="rec-badge rec-d">${st.totalD}D</span>` : ''}
          </div>
          <div class="lb-winrate" style="color:${wrColor}">${wr}%</div>
          <div id="${stId}-arrow" style="color:var(--muted);font-size:0.75rem;transition:transform 0.2s;text-align:right;">▼</div>
        </div>
        <div id="${stId}" style="display:none;border-top:1px solid #1a1a1a;">
          <table style="width:100%;border-collapse:collapse;">
            <thead><tr>
              <th style="padding-left:2rem;font-size:0.62rem;letter-spacing:0.1em;text-transform:uppercase;color:var(--muted);padding-top:6px;padding-bottom:6px;">Event</th>
              <th style="font-size:0.62rem;letter-spacing:0.1em;text-transform:uppercase;color:var(--muted);">Date</th>
              <th style="font-size:0.62rem;letter-spacing:0.1em;text-transform:uppercase;color:var(--muted);">Record</th>
              <th style="font-size:0.62rem;letter-spacing:0.1em;text-transform:uppercase;color:var(--muted);">Placing</th>
              <th></th>
            </tr></thead>
            <tbody>${eventBlocks}</tbody>
          </table>
        </div>
      </div>`;
  }).join('');
}


function rebuildStats() {
  clearFactionWRCache();
  invalidateEventsCache(); // D.events may have changed
  // clear all stats maps
  Object.keys(allStats).forEach(k => delete allStats[k]);
  FORMATS.forEach(f => { if (fmtStats[f]) Object.keys(fmtStats[f]).forEach(k => delete fmtStats[f][k]); });
  Object.keys(singlesStats).forEach(k => delete singlesStats[k]);

  // ensure fmtStats has all formats
  FORMATS.forEach(f => { if (!fmtStats[f]) fmtStats[f] = {}; });

  D.players.forEach(p => {
    ensurePlayerQ(allStats, p.name, p.factions);
    FORMATS.forEach(f => ensurePlayerQ(fmtStats[f], p.name, p.factions));
    ensurePlayerQ(singlesStats, p.name, p.factions);
  });

  getActiveEvents().forEach(ev => {
    const fmt = ev.format;
    const total = fmt === 'Teams' ? (ev.totalTeams || 1) : (ev.totalPlayers || 1);
    const quality = eventQuality(total);
    (ev.results || []).forEach(r => {
      if (r.dropped) return;
      const rWithTotal = { ...r, evTotal: total };
      ensurePlayerQ(allStats, r.player, []);
      if (fmt && fmtStats[fmt]) ensurePlayerQ(fmtStats[fmt], r.player, []);
      if (fmt !== 'Teams') ensurePlayerQ(singlesStats, r.player, []);
      addResultQ(allStats[r.player], rWithTotal, quality, ev.name);
      if (fmt && fmtStats[fmt]) addResultQ(fmtStats[fmt][r.player], rWithTotal, quality, ev.name);
      if (fmt !== 'Teams') addResultQ(singlesStats[r.player], rWithTotal, quality, ev.name);
    });
  });

  // rebuild summary strips
  ['summary-gt','summary-rtt','summary-teams'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.innerHTML = '';
  });
  buildStrip('summary-gt',    fmtStats['GT'],    'GT');
  buildStrip('summary-rtt',   fmtStats['RTT'],   'RTT');
  buildStrip('summary-teams', fmtStats['Teams'], 'Teams');

  // rebuild leaderboard
  renderLeaderboard(activeFilter);

  // rebuild format groups
  ['gt','rtt','teams'].forEach(k => { const el = document.getElementById('trn-'+k+'-results'); if(el) el.innerHTML=''; });
  teamsCardCount = 0;
  buildFormatGroups();

  // rebuild faction stats
  buildFactionStats();

  // reset awards so they rebuild on next visit
  awardsBuilt = false;
  if (document.getElementById('awards-grid')) document.getElementById('awards-grid').innerHTML = '';
  if (document.getElementById('milestones-grid')) document.getElementById('milestones-grid').innerHTML = '';

  // update header meta
  const activeEvs = getActiveEvents();
  const playerCount = Object.values(allStats).filter(s => s.games > 0).length;
  document.getElementById('header-meta').innerHTML =
    `<span>${D.season}</span><span>${D.game}</span><span>${activeEvs.length} event${activeEvs.length !== 1 ? 's' : ''}</span><span>${playerCount} players with results</span><span style="color:var(--accent);font-weight:500;">${ACTIVE_EDITION}th Edition</span>`;
  // Keep CoS section label in sync with active edition
  const cosLabel = document.getElementById('cos-edition-label');
  if (cosLabel) cosLabel.textContent = ACTIVE_EDITION === 10 ? '10th Edition' : '11th Edition';
  // buildNowPanel called after full init
}
// Stats are built above in the leaderboard section using quality-weighted ensurePlayerQ/addResultQ
// FORMATS kept for backward compatibility with buildStrip etc.


// -- header --
document.getElementById('team-title').textContent = D.team;
const evCount = getActiveEvents().length;
const playerCount = Object.values(allStats).filter(s => s.games > 0).length;
document.getElementById('header-meta').innerHTML =
  `<span>${D.season}</span><span>${D.game}</span><span>${evCount} event${evCount !== 1 ? 's' : ''}</span><span>${playerCount} players with results</span><span style="color:var(--accent);font-weight:500;">${ACTIVE_EDITION}th Edition</span>`;
document.getElementById('footer-team').textContent = D.team + ' · ' + D.season;
document.getElementById('footer-updated').textContent = D.lastUpdated ? 'Last updated: ' + D.lastUpdated : '';
if (D.version) {
  const vEl = document.getElementById('footer-version');
  if (vEl) vEl.textContent = 'v' + D.version;
}

const CALENDAR = [
  { name: "Winter ITT",        dates: "1-2 Feb 2025",       type: "Teams", attended: true,  sortDate: 20250201 },
  { name: "Spring ITT",        dates: "3-4 May 2025",       type: "Teams", attended: true,  sortDate: 20250503 },
  { name: "Bristol GT",        dates: "7-8 Jun 2025",       type: "GT",    attended: true,  sortDate: 20250607 },
  { name: "Leeds GT",          dates: "5-6 Jul 2025",       type: "GT",    attended: false, sortDate: 20250705 },
  { name: "Summer ITT",        dates: "2-3 Aug 2025",       type: "Teams", attended: true,  sortDate: 20250802 },
  { name: "LGT",               dates: "26-28 Sep 2025",     type: "GT",    attended: true,  sortDate: 20250926 },
  { name: "Coventry GT",       dates: "24-26 Oct 2025",     type: "GT",    attended: true,  sortDate: 20251024 },
  { name: "Autumn ITT",        dates: "15-16 Nov 2025",     type: "Teams", attended: true,  sortDate: 20251115 },
  { name: "Leicester GT",      dates: "6-7 Dec 2025",       type: "GT",    attended: false, sortDate: 20251206 },
  { name: "Nottingham GT",     dates: "10-11 Jan 2026",     type: "GT",    attended: true,  sortDate: 20260110 },
  { name: "Shaming in the New Year RTT", dates: "24 Jan 2026", type: "RTT", attended: true, sortDate: 20260124 },
  { name: "Winter ITT",        dates: "31 Jan-1 Feb 2026",  type: "Teams", attended: true,  sortDate: 20260131 },
  { name: "Manchester GT",     dates: "21-22 Feb 2026",     type: "GT",    attended: false, sortDate: 20260221 },
  { name: "Windsor Super Major", dates: "7-8 Mar 2026",     type: "GT",    attended: true,  sortDate: 20260307 },
  { name: "Sheffield GT",      dates: "28-29 Mar 2026",     type: "GT",    attended: false, sortDate: 20260328 },
  { name: "South Coast GT",    dates: "11-12 Apr 2026",     type: "GT",    attended: false, sortDate: 20260411 },
  { name: "Spring ITT",        dates: "2-3 May 2026",       type: "Teams", attended: false, sortDate: 20260502 },
  { name: "Bristol GT",        dates: "23-24 May 2026",     type: "GT",    attended: false, sortDate: 20260523 },
  { name: "Leeds GT",          dates: "13-14 Jun 2026",     type: "GT",    attended: false, sortDate: 20260613 },
  { name: "Birmingham GT",     dates: "4-5 Jul 2026",       type: "GT",    attended: false, sortDate: 20260704 },
  { name: "Edinburgh Super Major", dates: "18-19 Jul 2026", type: "GT",    attended: false, sortDate: 20260718 },
  { name: "Manchester GT: Summer", dates: "8-9 Aug 2026",   type: "GT",    attended: false, sortDate: 20260808 },
  { name: "Summer ITT",        dates: "29-30 Aug 2026",     type: "Teams", attended: false, sortDate: 20260829 },
  { name: "LGT",               dates: "25-27 Sep 2026",     type: "GT",    attended: false, sortDate: 20260925 },
  { name: "Coventry GT",       dates: "23-25 Oct 2026",     type: "GT",    attended: false, sortDate: 20261023 },
  { name: "Autumn ITT",        dates: "14-15 Nov 2026",     type: "Teams", attended: false, sortDate: 20261114 },
  { name: "Bedfordshire Super Major", dates: "5-6 Dec 2026", type: "GT",   attended: false, sortDate: 20261205 },
];

function getTodaySortDate() {
  const n = new Date(); n.setHours(0,0,0,0);
  return n.getFullYear()*10000 + (n.getMonth()+1)*100 + n.getDate();
}


// -- now panel --
function buildNowPanel() {
  const el = document.getElementById('now-panel');
  if (!el) return;

  // Parse "Mon YYYY" display date into a sortable number
  const MONTHS = {Jan:1,Feb:2,Mar:3,Apr:4,May:5,Jun:6,Jul:7,Aug:8,Sep:9,Oct:10,Nov:11,Dec:12};
  function evSortKey(ev) {
    if (ev.sortDate) return ev.sortDate;
    const m = (ev.date||'').match(/([A-Za-z]+)\s+(\d{4})/);
    if (m) return parseInt(m[2]) * 100 + (MONTHS[m[1]] || 0);
    return 0;
  }

  // Last event played -- most recent event WITH results (excludes future events)
  const events = getActiveEvents();
  const pastEvents = events.filter(ev => ev.results && ev.results.length > 0);
  const lastEvent = pastEvents.length
    ? [...pastEvents].sort((a,b) => evSortKey(b) - evSortKey(a))[0]
    : null;

  // Next calendar event
  const todayNum = getTodaySortDate ? getTodaySortDate() : parseInt(new Date().toISOString().slice(0,10).replace(/-/g,''));
  const nextCalEv = getCalendarEvents().filter(e => (e.sortDate||0) > todayNum)
    .sort((a,b) => a.sortDate - b.sortDate)[0];

  // Top 3 champions -- opted-in players only
  const ranked = getRanked('Singles');
  const nowOptins = getCosOptins();
  const teamAvg = getTeamAvg(singlesStats);
  const top3 = ranked.filter(s => nowOptins.has(s.name)).slice(0,3).map((s,i) => {
    const wr = Math.round(bayesianWinRate(s, teamAvg)*100);
    const medal = ['🥇','🥈','🥉'][i];
    return `<div style="display:flex;align-items:center;gap:8px;padding:4px 0;${i<2?'border-bottom:1px solid var(--border);':''}">
      <span style="font-size:1rem;">${medal}</span>
      <span style="font-size:0.85rem;color:var(--text);flex:1;">${s.name}</span>
      <span style="font-family:'Bebas Neue',sans-serif;font-size:1rem;color:${i===0?'#ff6a00':'var(--muted)'};">${wr}%</span>
    </div>`;
  }).join('');

  // League pod leaders -- requires leagueData
  let leagueHtml = '';
  const ld = leagueData;
  if (ld?.pods?.length) {
    const podLeaders = ld.pods.map(pod => {
      const { sorted, podGames, podPlayers: pp } = calcPodStandings(pod.id, ld.players, ld.games);
      const leader = sorted[0];
      const maxPossible = pp.length * (pp.length-1) / 2;
      const pct = maxPossible ? Math.round((podGames.length/maxPossible)*100) : 0;
      return `<div style="display:flex;align-items:center;justify-content:space-between;padding:4px 0;border-bottom:1px solid var(--border);gap:8px;">
        <span style="font-size:0.72rem;color:var(--muted);min-width:38px;">${pod.name}</span>
        <span style="font-size:0.82rem;color:var(--text);flex:1;">${leader?.name||'TBD'}</span>
        <span style="font-size:0.72rem;color:${leader?.pts>0?'var(--win)':'var(--muted)'};">${leader?.pts||0}pts</span>
        <div style="width:40px;height:4px;background:var(--surface2);border-radius:2px;overflow:hidden;">
          <div style="width:${pct}%;height:100%;background:var(--accent);border-radius:2px;"></div>
        </div>
      </div>`;
    }).join('');
    leagueHtml = `
      <div style="background:var(--surface);border:1px solid var(--border);border-radius:6px;padding:1rem;">
        <div style="font-size:0.65rem;font-weight:500;letter-spacing:0.1em;text-transform:uppercase;color:var(--muted);margin-bottom:10px;">League Leaders</div>
        ${podLeaders}
        <div style="margin-top:8px;font-size:0.68rem;color:var(--faint);">Progress bar = games played</div>
      </div>`;
  }

  // Most recent result
  const recentHtml = lastEvent ? `
    <div style="background:var(--surface);border:1px solid var(--border);border-radius:6px;padding:1rem;">
      <div style="font-size:0.65rem;font-weight:500;letter-spacing:0.1em;text-transform:uppercase;color:var(--muted);margin-bottom:8px;">Most Recent Event</div>
      <div style="font-size:0.88rem;color:var(--text);margin-bottom:4px;">${lastEvent.name}</div>
      <div style="font-size:0.75rem;color:var(--muted);margin-bottom:8px;">${lastEvent.date} · ${lastEvent.format} · ${lastEvent.totalPlayers} players</div>
      ${(lastEvent.results||[]).filter(r=>!r.dropped).slice(0,3).map(r =>
        `<div style="display:flex;justify-content:space-between;align-items:center;padding:3px 0;border-bottom:1px solid var(--border);font-size:0.78rem;">
          <span style="color:var(--text);">${r.player}</span>
          <span style="color:var(--muted);">${r.placing}/${lastEvent.totalPlayers} · ${r.w}W ${r.l}L</span>
        </div>`
      ).join('')}
      <div style="margin-top:8px;">
        <button onclick="toggleSection('sec-tournaments');switchTrnTab('${lastEvent.format==='GT'?'gt':lastEvent.format==='RTT'?'rtt':'teams'}');" 
          style="font-size:0.72rem;color:var(--accent);background:none;border:none;cursor:pointer;padding:0;text-decoration:underline;">
          See full results ↓
        </button>
      </div>
    </div>` : '';

  // Next event
  const nextEvHtml = nextCalEv ? `
    <div style="background:var(--surface);border:1px solid var(--border);border-radius:6px;padding:1rem;">
      <div style="font-size:0.65rem;font-weight:500;letter-spacing:0.1em;text-transform:uppercase;color:var(--muted);margin-bottom:8px;">Next Event</div>
      <div style="font-size:0.88rem;color:var(--text);margin-bottom:4px;">${nextCalEv.name}</div>
      <div style="font-size:0.75rem;color:var(--muted);margin-bottom:4px;">${nextCalEv.dates}</div>
      <span style="font-size:0.65rem;padding:2px 6px;border-radius:3px;background:var(--surface2);color:var(--muted);">${nextCalEv.type}</span>
    </div>` : '';

  // Champions top 3
  const champHtml = top3 ? `
    <div style="background:var(--surface);border:1px solid var(--border);border-radius:6px;padding:1rem;">
      <div style="font-size:0.65rem;font-weight:500;letter-spacing:0.1em;text-transform:uppercase;color:var(--muted);margin-bottom:10px;">Champions of Shame -- Top 3</div>
      ${top3}
      <div style="margin-top:8px;">
        <button onclick="toggleSection('sec-champions');document.getElementById('sec-champions').scrollIntoView({behavior:'smooth'});" 
          style="font-size:0.72rem;color:var(--accent);background:none;border:none;cursor:pointer;padding:0;text-decoration:underline;">
          Full rankings ↓
        </button>
      </div>
    </div>` : '';

  el.innerHTML = `
    <div style="margin-bottom:6px;">
      <div style="font-size:0.65rem;font-weight:500;letter-spacing:0.12em;text-transform:uppercase;color:var(--muted);">
        What's happening · ${new Date().toLocaleDateString('en-GB',{weekday:'long',day:'numeric',month:'long',year:'numeric'})}
      </div>
    </div>
    <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:12px;">
      ${recentHtml}
      ${nextEvHtml}
      ${champHtml}
      ${leagueHtml}
    </div>`;
}


// -- summary strips --
function buildStrip(containerId, statsMap, label) {
  const el = document.getElementById(containerId);
  if (!el) return;
  el.innerHTML = '';
  const block = el.closest('.summary-block');
  if (block) block.style.display = '';
  const players = Object.values(statsMap).filter(s => s.games > 0);
  if (!players.length) { if (block) block.style.display = 'none'; return; }
  const W = players.reduce((a,s)=>a+s.w,0);
  const L = players.reduce((a,s)=>a+s.l,0);
  const Dv = players.reduce((a,s)=>a+s.d,0);
  const G = W+L+Dv;
  const wr = G ? Math.round((W/G)*100) : 0;
  const evts = getActiveEvents().filter(e => e.format === label).length;
  const uniquePlayers = players.length;
  [
    { label: 'Events',          val: evts,          cls: '' },
    { label: 'Players active',  val: uniquePlayers,  cls: '' },
    { label: 'Total games',     val: G,              cls: '' },
    { label: 'Wins',            val: W,              cls: 'w' },
    { label: 'Losses',          val: L,              cls: 'l' },
    { label: 'Draws',           val: Dv,             cls: 'd' },
    { label: 'Win rate',        val: wr+'%',         cls: '' },
  ].forEach(s => {
    el.innerHTML += `<div class="stat-cell"><div class="stat-label">${s.label}</div><div class="stat-value ${s.cls}">${s.val}</div></div>`;
  });
}
buildStrip('summary-gt',    fmtStats['GT'],    'GT');
buildStrip('summary-rtt',   fmtStats['RTT'],   'RTT');
buildStrip('summary-teams', fmtStats['Teams'], 'Teams');

// Build now panel -- will refresh with league data once loaded
// buildNowPanel called from initSite after all vars declared

// -- Champions of Shame opt-in --
// CoS opt-ins stored as individual rows: player_name = name, event_sort_date = 19700102, status = 'cos_optin'
// Using 19700102 to distinguish from other special keys that use 19700101
function getCosOptins() {
  const optins = new Set();
  Object.entries(attendanceData).forEach(([key, val]) => {
    if (val === 'cos_optin') {
      const name = key.replace(/_19700102$/, '');
      optins.add(name);
    }
  });
  return optins;
}

async function saveCosOptins(names) {
  // Get current opted-in set from DB to diff against
  const current = getCosOptins();
  const toAdd = [...names].filter(n => !current.has(n));
  const toRemove = [...current].filter(n => !names.has(n));

  try {
    // Add new opt-ins
    for (const name of toAdd) {
      await fetch(`${API}/attendance`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ player_name: name, event_sort_date: 19700102, status: 'cos_optin', pin: TEAM_PIN })
      });
    }
    // Remove opt-outs
    for (const name of toRemove) {
      await fetch(`${API}/attendance`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ player_name: name, event_sort_date: 19700102, pin: TEAM_PIN })
      });
    }
    await loadAttendance(true); // force reload after write
  } catch(e) {
    console.warn('Failed to save CoS optins', e);
  }
}

async function toggleCosOptin(name) {
  const optins = getCosOptins();
  if (optins.has(name)) optins.delete(name); else optins.add(name);
  await saveCosOptins(optins);
  renderLeaderboard(activeFilter);
}

function renderLeaderboard(filter) {
  if (filter === 'Teams') { renderTeamsLeaderboard(); return; }
  const lbEl = document.getElementById('leaderboard');
  const ranked = getRanked(filter);
  if (!ranked.length) {
    lbEl.innerHTML = `<div style="padding:1.5rem;color:var(--muted);font-size:0.85rem;">
      No ${ACTIVE_EDITION === 11 ? '11th edition ' : ''}results yet${ACTIVE_EDITION === 11 ? ' — rankings will appear after the first event results are imported' : ''}.
      ${ACTIVE_EDITION === 11 ? '<div style="margin-top:8px;font-size:0.78rem;">10th edition stats are available via the <strong style=\'color:var(--text)\'>10th</strong> button above.</div>' : ''}
    </div>`;
    return;
  }

  const map = filter === 'Singles' ? singlesStats : filter === 'All' ? allStats : fmtStats[filter];
  const teamAvg = getTeamAvg(map);
  const optins = getCosOptins();

  // Only show opted-in players on the leaderboard; others are hidden but ranked internally
  const optedIn = ranked.filter(s => optins.has(s.name));
  // Players not opted in are fully excluded -- opt-out means opt-out

  // Qualified/provisional split within opted-in only
  const qualified   = optedIn.filter(s => (s.events?.size || 0) >= PROVISIONAL_MIN_EVENTS);
  const provisional = optedIn.filter(s => (s.events?.size || 0) < PROVISIONAL_MIN_EVENTS);

  function buildRow(s, i, isProvisional) {
    const rawWr = s.games ? Math.round((s.w / s.games) * 100) : 0;
    const weightedWr = Math.round(bayesianWinRate(s, teamAvg) * 100);
    const mainFaction = mostPlayedFaction(s.name, filter);
    const factionDisplay = mainFaction
      ? mainFaction + (s.factions.size > 1 ? ` <span style="font-size:0.65rem;color:var(--faint);">+${s.factions.size - 1} more</span>` : '')
      : ([...s.factions].filter(Boolean).join(', ') || '--');
    const topCls = (!isProvisional && i < 3) ? ' top3' : '';
    const wrColor = isProvisional ? 'var(--muted)' : weightedWr >= 60 ? '#ff6a00' : weightedWr >= 40 ? 'var(--text)' : 'var(--loss)';
    const cardId = 'lb-' + s.name.replace(/\s+/g, '-').toLowerCase() + '-' + filter;
    const opacity = isProvisional ? '0.6' : '1';
    const eventsAttended = s.events?.size || 0;

    // Best result badge
    const br = s.bestResult;
    const bestResultHtml = br
      ? `<span style="font-size:0.65rem;padding:1px 5px;border-radius:3px;background:${br.pct <= 0.1 ? 'rgba(255,106,0,0.15)' : 'var(--surface2)'};color:${br.pct <= 0.1 ? '#ff6a00' : 'var(--muted)'};border:1px solid ${br.pct <= 0.1 ? 'rgba(255,106,0,0.3)' : 'var(--border)'};" title="Best result: ${br.placing}/${br.total} at ${br.eventName}">
        Best: ${br.placing}/${br.total}
      </span>`
      : '';

    // Form guide -- one dot per event (W/L based on event result), last 5 events
    const playerEvents = getActiveEvents()
      .filter(ev => {
        if (filter !== 'Singles' && filter !== 'All' && ev.format !== filter) return false;
        if (filter === 'Singles' && ev.format === 'Teams') return false;
        return (ev.results || []).some(r => r.player === s.name && !r.dropped);
      })
      .sort((a,b) => (a.sortDate||0) - (b.sortDate||0));
    const last5Events = playerEvents.slice(-5);
    const dotColor = { w: 'var(--win)', l: 'var(--loss)', d: 'var(--draw)' };
    const formDots = last5Events.map(ev => {
      const r = (ev.results||[]).find(r => r.player === s.name);
      if (!r) return '';
      const result = r.shadow ? 'w' : (r.w > r.l ? 'w' : r.l > r.w ? 'l' : 'd');
      const qMult = eventQuality(ev.format === 'Teams' ? (ev.totalTeams||1) : (ev.totalPlayers||1));
      const sizePx = Math.round(7 + qMult * 3); // bigger dot = bigger event
      return `<span title="${ev.name}: ${r.w}W ${r.l}L" style="display:inline-block;width:${sizePx}px;height:${sizePx}px;border-radius:50%;background:${dotColor[result]};opacity:0.85;flex-shrink:0;"></span>`;
    }).join('');
    const formHtml = `<div style="display:flex;gap:3px;align-items:center;margin-top:3px;">${formDots}</div>`;

    const evRows = getActiveEvents().filter(ev => {
      if (filter !== 'Singles' && filter !== 'All' && ev.format !== filter) return false;
      if (filter === 'Singles' && ev.format === 'Teams') return false;
      return (ev.results||[]).some(r => r.player === s.name && !r.dropped);
    }).map(ev => {
      const r = ev.results.find(r => r.player === s.name);
      if (!r) return '';
      const total = ev.format === 'Teams' ? ev.totalTeams : ev.totalPlayers;
      const placingStr = r.dropped ? '--' : `${r.placing} / ${total}`;
      const q = eventQuality(total);
      const qBadge = `<span style="font-size:0.6rem;color:var(--muted);margin-left:6px;" title="Event quality: ${q.toFixed(2)}x">${q.toFixed(1)}x</span>`;
      const shadowTag = r.shadow ? ` <span style="font-size:0.62rem;color:var(--accent);border:1px solid var(--accent-muted);padding:1px 5px;border-radius:3px;margin-left:4px;">5-0 shadow</span>` : '';
      const subteamStr = r.subteam ? `<div style="font-size:0.68rem;color:var(--muted);margin-top:1px;">${r.subteam}</div>` : '';
      return `<tr>
        <td style="padding-left:2rem;font-size:0.8rem;color:var(--text);">${ev.name}${shadowTag}${qBadge}${subteamStr}</td>
        <td style="font-size:0.78rem;color:var(--muted);">${r.faction}</td>
        <td style="font-size:0.78rem;color:var(--muted);">${ev.date}</td>
        <td style="font-size:0.78rem;"><span class="format-pill">${ev.format}</span></td>
        <td style="font-size:0.8rem;color:${r.placing <= Math.ceil(total*0.1) ? '#ff6a00' : 'var(--text)'};">${placingStr}</td>
        <td style="text-align:right;">
          <div style="display:flex;gap:4px;justify-content:flex-end;">
            <span class="rec-badge rec-w">${r.w}W</span>
            <span class="rec-badge rec-l">${r.l}L</span>
            ${r.d > 0 ? `<span class="rec-badge rec-d">${r.d}D</span>` : ''}
          </div>
        </td>
      </tr>`;
    }).join('');

    return `
    <div class="lb-row${topCls}" style="display:block;padding:0;cursor:pointer;opacity:${opacity};" onclick="toggleLb('${cardId}')">
      <div class="lb-inner" onmouseover="this.style.background='rgba(255,255,255,0.03)'" onmouseout="this.style.background='transparent'">
        <div class="lb-rank">${isProvisional ? '--' : i + 1}</div>
        <div>
          <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
            <span class="lb-name player-link" onclick="event.stopPropagation();openPlayerPanel('${safeAttr(s.name)}')">${s.name}</span>
            ${bestResultHtml}
          </div>
          <div class="lb-faction" style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
            ${factionDisplay}
            ${(() => { const fwr = mainFaction ? getFactionWR(mainFaction) : null; return fwr !== null ? `<span style="font-size:0.65rem;padding:1px 5px;border-radius:3px;background:${fwr>=60?'rgba(255,106,0,0.12)':fwr>=50?'var(--win-bg)':'var(--surface2)'};color:${fwr>=60?'#ff6a00':fwr>=50?'var(--win)':'var(--muted)'};">${fwr}% wr</span>` : ''; })()}
            <span style="font-size:0.65rem;color:var(--faint);">${eventsAttended} event${eventsAttended !== 1 ? 's' : ''}</span>
          </div>
          ${formHtml}
        </div>
        <div class="lb-record">
          <span class="rec-badge rec-w">${s.w}W</span>
          <span class="rec-badge rec-l">${s.l}L</span>
          ${s.d > 0 ? `<span class="rec-badge rec-d">${s.d}D</span>` : ''}
        </div>
        <div style="text-align:right;">
          <div style="font-family:'Bebas Neue',sans-serif;font-size:1.3rem;letter-spacing:0.04em;color:${wrColor};">${weightedWr}%</div>
          <div style="font-size:0.65rem;color:var(--muted);letter-spacing:0.04em;">${s.games} games · ${rawWr}% raw</div>
        </div>
        <div id="${cardId}-arrow" style="color:var(--muted);font-size:0.75rem;transition:transform 0.2s;text-align:right;">▼</div>
      </div>
      <div id="${cardId}" style="display:none;border-top:1px solid #1a1a1a;">
        <table class="event-table">
          <thead><tr>
            <th style="padding-left:2rem">Event</th>
            <th>Faction</th>
            <th>Date</th>
            <th>Format</th>
            <th>Placing</th>
            <th style="text-align:right">W / L / D</th>
          </tr></thead>
          <tbody>${evRows}</tbody>
        </table>
      </div>
    </div>`;
  }

  let html = '';

  if (!optedIn.length) {
    html = `<div style="padding:1.5rem;text-align:center;">
      <div style="font-size:0.88rem;color:var(--text);margin-bottom:6px;">No one has opted in yet</div>
      <div style="font-size:0.78rem;color:var(--muted);margin-bottom:12px;">Rankings are calculated but hidden until players opt in.</div>
      <button onclick="switchTab('members')" style="padding:7px 18px;background:var(--accent);border:none;border-radius:4px;color:#fff;font-family:'DM Sans',sans-serif;font-size:0.82rem;cursor:pointer;">
        Go to Members tab to opt in →
      </button>
    </div>`;
  } else {
    html = qualified.map((s, i) => buildRow(s, i, false)).join('');
    if (provisional.length) {
      html += `
        <div style="margin-top:1rem;padding:8px 0 6px;border-top:1px solid var(--border);">
          <div style="font-size:0.68rem;font-weight:500;letter-spacing:0.1em;text-transform:uppercase;color:var(--muted);padding:0 4px 8px;">Provisional -- fewer than ${PROVISIONAL_MIN_EVENTS} events attended</div>
          ${provisional.map((s, i) => buildRow(s, i, true)).join('')}
        </div>`;
    }
  }

  lbEl.innerHTML = html;
}

function toggleLb(id) {
  const el = document.getElementById(id);
  const arrow = document.getElementById(id + '-arrow');
  const open = el.style.display === 'block';
  el.style.display = open ? 'none' : 'block';
  if (arrow) arrow.style.transform = open ? '' : 'rotate(180deg)';
}

// render filter buttons
const filterEl = document.getElementById('lb-filters');
filters.forEach(f => {
  const btn = document.createElement('button');
  btn.textContent = f;
  btn.className = 'filter-btn' + (f === 'Singles' ? ' active' : '');
  btn.onclick = () => {
    activeFilter = f;
    document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    renderLeaderboard(f);
  };
  filterEl.appendChild(btn);
});
// renderLeaderboard called from initSite after attendance is loaded

// -- format groups with collapsible events --
const formatOrder = ['GT', 'RTT', 'Teams'];
let teamsCardCount = 0;

function buildFormatGroups() {
formatOrder.forEach(fmt => {
  const fmtEvents = getActiveEvents().filter(ev => ev.format === fmt);
  if (!fmtEvents.length) return;

  const groupId = 'fmt-' + fmt.toLowerCase();
  const fmtLabel = fmt === 'GT' ? 'Grand Tournaments' : fmt === 'RTT' ? 'RTTs' : 'Teams Events';

  let eventsHtml = fmtEvents.map(ev => {
    const isTeams = ev.format === 'Teams';
    const evId = 'ev-' + ev.name.replace(/[^a-z0-9]/gi,'-').toLowerCase();
    const bcpLink = ev.bcpUrl ? `<a href="${ev.bcpUrl}" target="_blank" rel="noopener" style="color:var(--accent);text-decoration:none;">View on BCP ↗</a>` : '';
    const metaCount = isTeams ? `${ev.totalTeams} teams · ${ev.totalPlayers} players` : (ev.totalPlayers ? `${ev.totalPlayers} players` : '');

    let bodyHtml = '';

    if (isTeams) {
      // Build subteam groups from r.subteam on results -- ev.subteams doesn't exist for DB events
      const groups = {};
      (ev.results || []).forEach(r => {
        const key = r.subteam || '_no_subteam';
        if (!groups[key]) groups[key] = {
          meta: { name: r.subteam || 'Unknown', placing: r.placing || 0, w: 0, l: 0, d: 0 },
          players: []
        };
        groups[key].players.push(r);
        groups[key].meta.w += r.w || 0;
        groups[key].meta.l += r.l || 0;
        groups[key].meta.d += r.d || 0;
        // placing is same for all players in subteam -- keep highest (lowest number)
        if (r.placing && (!groups[key].meta.placing || r.placing < groups[key].meta.placing)) {
          groups[key].meta.placing = r.placing;
        }
      });
      bodyHtml = Object.values(groups).sort((a,b) => a.meta.placing - b.meta.placing).map(g => {
        const st = g.meta;
        const cardId = 'st-' + (teamsCardCount++);
        const isTop = st.placing <= Math.ceil(ev.totalTeams * 0.15);
        const playerRows = g.players.map(r => `
          <tr>
            <td class="player-cell" style="padding-left:2rem">${r.player}</td>
            <td>${r.faction}</td>
            <td class="wld-cell">
              <span class="rec-badge rec-w">${r.w}W</span>
              <span class="rec-badge rec-l">${r.l}L</span>
              ${r.d > 0 ? `<span class="rec-badge rec-d">${r.d}D</span>` : ''}
            </td>
          </tr>`).join('');
        return `
          <div style="border-bottom:1px solid #1a1a1a;">
            <div onclick="toggleSubteam('${cardId}')" style="display:grid;grid-template-columns:1fr auto auto auto;align-items:center;gap:12px;padding:12px 16px;cursor:pointer;transition:background 0.15s;" onmouseover="this.style.background='#3a3a3a'" onmouseout="this.style.background='transparent'">
              <div>
                <div style="font-size:0.9rem;font-weight:400;color:var(--text);">${st.name}</div>
                <div style="font-size:0.72rem;color:var(--muted);margin-top:2px;">${g.players.length} players</div>
              </div>
              <div style="display:flex;gap:6px;">
                <span class="rec-badge rec-w">${st.w}W</span>
                <span class="rec-badge rec-l">${st.l}L</span>
                ${st.d > 0 ? `<span class="rec-badge rec-d">${st.d}D</span>` : ''}
              </div>
              <div style="font-family:'Bebas Neue',sans-serif;font-size:1.1rem;letter-spacing:0.04em;min-width:60px;text-align:right;color:${isTop ? '#ff6a00' : 'var(--text)'};">${st.placing} <span style="font-size:0.7rem;color:var(--muted);font-family:'DM Sans',sans-serif;font-weight:300">/ ${ev.totalTeams}</span></div>
              <div id="${cardId}-arrow" style="color:var(--muted);font-size:0.8rem;transition:transform 0.2s;min-width:16px;text-align:right;">▼</div>
            </div>
            <div id="${cardId}" style="display:none;border-top:1px solid #1a1a1a;">
              <table class="event-table">
                <thead><tr><th style="padding-left:2rem">Player</th><th>Faction</th><th style="text-align:right">W / L / D</th></tr></thead>
                <tbody>${playerRows}</tbody>
              </table>
            </div>
          </div>`;
      }).join('');
    } else {
      const sorted = [...ev.results].sort((a,b) => a.placing - b.placing);
      const rows = sorted.map(r => {
        if (r.dropped) {
          const outOf = ev.totalPlayers ? ` <span style="font-size:0.7rem;color:var(--muted);font-family:'DM Sans',sans-serif;font-weight:300">/ ${ev.totalPlayers}</span>` : '';
          return `<tr style="opacity:0.6;">
            <td class="player-cell"><span class="player-link" onclick="openPlayerPanel('${safeAttr(r.player)}')">${r.player}</span> <span style="font-size:0.62rem;color:var(--loss);border:1px solid var(--loss);padding:1px 5px;border-radius:3px;margin-left:4px;">Dropped</span></td>
            <td>${r.faction}</td>
            <td class="placing-cell" style="color:var(--muted)">${r.placing > 0 ? r.placing + (ev.totalPlayers ? ' / ' + ev.totalPlayers : '') : '--'}</td>
            <td class="wld-cell">
              <span class="rec-badge rec-w">${r.w}W</span>
              <span class="rec-badge rec-l">${r.l}L</span>
              ${r.d > 0 ? `<span class="rec-badge rec-d">${r.d}D</span>` : ''}
            </td>
          </tr>`;
        }
        const isTop = r.placing <= Math.ceil(ev.totalPlayers * 0.1);
        const placingCls = isTop ? ' placing-top' : '';
        const outOf = ev.totalPlayers ? ` <span style="font-size:0.7rem;color:var(--muted);font-family:'DM Sans',sans-serif;font-weight:300">/ ${ev.totalPlayers}</span>` : '';
        const shadowTag = r.shadow ? ` <span style="font-size:0.62rem;color:var(--accent);border:1px solid var(--accent-muted);padding:1px 5px;border-radius:3px;letter-spacing:0.04em;margin-left:6px;">5-0 shadow</span>` : '';
        return `<tr>
          <td class="player-cell"><span class="player-link" onclick="openPlayerPanel('${safeAttr(r.player)}')">${r.player}</span>${shadowTag}</td>
          <td>${r.faction}</td>
          <td class="placing-cell${placingCls}">${r.placing}${outOf}</td>
          <td class="wld-cell">
            <span class="rec-badge rec-w">${r.w}W</span>
            <span class="rec-badge rec-l">${r.l}L</span>
            ${r.d > 0 ? `<span class="rec-badge rec-d">${r.d}D</span>` : ''}
          </td>
        </tr>`;
      }).join('');
      bodyHtml = `<table class="event-table">
        <thead><tr><th>Player</th><th>Faction</th><th>Placing</th><th style="text-align:right">W / L / D</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>`;
    }

    return `
      <div class="event-card" style="border-radius:0;border-left:none;border-right:none;border-top:none;border-bottom:1px solid var(--border);">
        <div class="event-header" onclick="toggleEvt('${evId}')" style="cursor:pointer;" onmouseover="this.style.background='var(--surface2)'" onmouseout="this.style.background='transparent'">
          <div>
            <div class="event-name">${ev.name}</div>
            <div class="event-meta">
              <span>${ev.date}</span>
              ${metaCount ? `<span>${metaCount}</span>` : ''}
              ${bcpLink}
            </div>
          </div>
          <div id="${evId}-arrow" style="color:var(--muted);font-size:0.8rem;transition:transform 0.2s;margin-left:12px;">▼</div>
        </div>
        <div id="${evId}" style="display:none;border-top:1px solid var(--border);">
          ${bodyHtml}
        </div>
      </div>`;
  }).join('');

  // Write events into per-format results container with a collapsible wrapper
  const fmtKey = fmt === 'GT' ? 'gt' : fmt === 'RTT' ? 'rtt' : 'teams';
  const resultEl = document.getElementById('trn-' + fmtKey + '-results');
  if (resultEl) resultEl.innerHTML = `
    <div style="margin-top:1rem;">
      <div onclick="toggleTrnResults('${fmtKey}')"
        style="display:flex;align-items:center;justify-content:space-between;padding:8px 0;cursor:pointer;border-top:1px solid var(--border);"
        onmouseover="this.style.opacity='0.75'" onmouseout="this.style.opacity='1'">
        <span style="font-size:0.65rem;font-weight:500;letter-spacing:0.12em;text-transform:uppercase;color:var(--muted);">
          Event Results <span style="color:var(--faint);">(${fmtEvents.length})</span>
        </span>
        <span id="trn-${fmtKey}-arrow" style="color:var(--muted);font-size:0.75rem;transition:transform 0.2s;transform:rotate(-90deg);">▼</span>
      </div>
      <div id="trn-${fmtKey}-evlist" style="display:none;">
        ${eventsHtml}
      </div>
    </div>`;
});
} // end buildFormatGroups
buildFormatGroups();

// -- toggle helpers --
function toggleSection(id) {
  const el = document.getElementById(id);
  const arrow = document.getElementById(id + '-arrow');
  const open = el.style.display !== 'none';
  el.style.display = open ? 'none' : '';
  if (arrow) arrow.style.transform = open ? 'rotate(-90deg)' : '';
}


function toggleEvt(id) {
  const el = document.getElementById(id);
  const arrow = document.getElementById(id + '-arrow');
  const open = el.style.display === 'block';
  el.style.display = open ? 'none' : 'block';
  arrow.style.transform = open ? '' : 'rotate(180deg)';
}
function toggleSubteam(id) {
  const el = document.getElementById(id);
  const arrow = document.getElementById(id + '-arrow');
  const open = el.style.display === 'block';
  el.style.display = open ? 'none' : 'block';
  arrow.style.transform = open ? '' : 'rotate(180deg)';
}

// -- tournament tab switcher --
let activeTrnTab = 'gt';
function switchTrnTab(tab) {
  activeTrnTab = tab;
  ['gt','rtt','teams'].forEach(t => {
    document.getElementById('trn-' + t).style.display = t === tab ? '' : 'none';
    document.getElementById('trn-btn-' + t).classList.toggle('active', t === tab);
  });
}

function toggleTrnResults(fmtKey) {
  const list = document.getElementById('trn-' + fmtKey + '-evlist');
  const arrow = document.getElementById('trn-' + fmtKey + '-arrow');
  const open = list.style.display !== 'none';
  list.style.display = open ? 'none' : 'block';
  arrow.style.transform = open ? 'rotate(-90deg)' : '';
}

// -- champions tab switcher --
async function switchChamTab(tab) {
  ['players','factions'].forEach(t => {
    document.getElementById('cham-' + t).style.display = t === tab ? '' : 'none';
    document.getElementById('cham-btn-' + t).classList.toggle('active', t === tab);
  });
  if (tab === 'factions') buildFactionStats();
  if (tab === 'players') {
    await loadAttendance();
    renderLeaderboard(activeFilter);
  }
}

function toggleCalWho(id) {
  const el = document.getElementById(id);
  const arrow = document.getElementById(id + '-arrow');
  if (!el) return;
  const open = el.style.display !== 'none';
  el.style.display = open ? 'none' : 'block';
  if (arrow) arrow.style.transform = open ? '' : 'rotate(180deg)';
}

// -- Members tab --

function initMembersTab() {
  buildMemberNameList();
  const stored = localStorage.getItem('pssn_member');
  if (stored && D.players.some(p => p.name === stored)) {
    showMemberProfile(stored);
  }
}

function buildMemberNameList() {
  const el = document.getElementById('members-name-list');
  if (!el) return;
  if (el.children.length && !el.dataset.rebuild) return; // only build once unless forced
  el.dataset.rebuild = '';
  el.innerHTML = '';
  const stored = localStorage.getItem('pssn_member');
  [...D.players].sort((a,b) => a.name.localeCompare(b.name)).forEach(p => {
    const btn = document.createElement('button');
    const isMe = p.name === stored;
    btn.textContent = p.name;
    btn.style.cssText = `
      display:block;width:100%;text-align:left;
      padding:9px 14px;font-family:'DM Sans',sans-serif;font-size:0.82rem;
      border:none;border-bottom:1px solid var(--border);cursor:pointer;transition:all 0.15s;
      background:${isMe ? 'var(--accent-bg)' : 'transparent'};
      color:${isMe ? 'var(--accent)' : 'var(--text)'};
      border-left:${isMe ? '3px solid var(--accent)' : '3px solid transparent'};
    `;
    btn.onmouseover = () => { if (p.name !== window._memberName) { btn.style.background = 'var(--surface2)'; } };
    btn.onmouseout = () => { if (p.name !== window._memberName) { btn.style.background = 'transparent'; } };
    btn.onclick = () => selectMember(p.name);
    btn.id = `member-btn-${p.name.replace(/\s+/g,'-').toLowerCase()}`;
    el.appendChild(btn);
  });
}

function selectMember(name) {
  localStorage.setItem('pssn_member', name);
  localStorage.setItem('pssn_nudge_dismissed', '1');
  window._memberName = name;
  // Dismiss welcome nudge
  const nudge = document.getElementById('welcome-nudge');
  if (nudge) nudge.style.display = 'none';
  // Update button styles
  [...D.players].forEach(p => {
    const btn = document.getElementById(`member-btn-${p.name.replace(/\s+/g,'-').toLowerCase()}`);
    if (!btn) return;
    const isMe = p.name === name;
    btn.style.background = isMe ? 'var(--accent-bg)' : 'transparent';
    btn.style.color = isMe ? 'var(--accent)' : 'var(--text)';
    btn.style.borderLeft = isMe ? '3px solid var(--accent)' : '3px solid transparent';
  });
  showMemberProfile(name);
}

async function showMemberProfile(name) {
  window._memberName = name;
  document.getElementById('members-profile').style.display = 'block';
  setTimeout(() => document.getElementById('members-profile').scrollIntoView({ behavior: 'smooth', block: 'start' }), 50);

  // Always load fresh attendance before reading opt-in state
  await loadAttendance();
  const optins = getCosOptins();
  updateCosToggleUI(optins.has(name));

  // Populate inline stats preview
  buildMemberStatsPreview(name);
}

function buildMemberStatsPreview(name) {
  const el = document.getElementById('members-stats-preview');
  if (!el) return;

  const s = allStats[name];
  if (!s || !s.games) {
    el.innerHTML = `<div style="font-size:0.85rem;color:var(--muted);">No results recorded yet.</div>`;
    return;
  }

  const wr = Math.round((s.w / s.games) * 100);
  const wrColor = wr >= 60 ? '#ff6a00' : wr >= 40 ? 'var(--text)' : 'var(--loss)';
  const playerEvents = getActiveEvents().filter(ev => ev.results.some(r => r.player === name && !r.dropped));
  const mainFaction = mostPlayedFaction(name);

  // Champions rank
  const singlesRanked = getRanked('Singles');
  const champPos = singlesRanked.findIndex(p => p.name === name);
  const optins = getCosOptins();
  const isOptedIn = optins.has(name);

  const bestResult = getActiveEvents().reduce((best, ev) => {
    const r = ev.results.find(r => r.player === name);
    if (!r || r.dropped) return best;
    const total = ev.format === 'Teams' ? ev.totalTeams : ev.totalPlayers;
    const pct = r.placing / total;
    if (!best || pct < best.pct) return { pct, placing: r.placing, total, event: ev.name };
    return best;
  }, null);

  el.innerHTML = `
    <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(110px,1fr));gap:8px;margin-bottom:1.25rem;">
      <div style="background:var(--surface2);border-radius:4px;padding:10px 12px;">
        <div style="font-size:0.62rem;color:var(--muted);text-transform:uppercase;letter-spacing:0.08em;margin-bottom:4px;">Win Rate</div>
        <div style="font-family:'Bebas Neue',sans-serif;font-size:1.8rem;color:${wrColor};line-height:1;">${wr}%</div>
        <div style="font-size:0.65rem;color:var(--faint);">${s.games} games</div>
      </div>
      <div style="background:var(--surface2);border-radius:4px;padding:10px 12px;">
        <div style="font-size:0.62rem;color:var(--muted);text-transform:uppercase;letter-spacing:0.08em;margin-bottom:4px;">Record</div>
        <div style="display:flex;gap:4px;margin-top:4px;flex-wrap:wrap;">
          <span style="font-size:0.72rem;padding:2px 6px;border-radius:3px;background:var(--win-bg);color:var(--win);">${s.w}W</span>
          <span style="font-size:0.72rem;padding:2px 6px;border-radius:3px;background:var(--loss-bg);color:var(--loss);">${s.l}L</span>
          ${s.d > 0 ? `<span style="font-size:0.72rem;padding:2px 6px;border-radius:3px;background:#152030;color:var(--draw);">${s.d}D</span>` : ''}
        </div>
      </div>
      <div style="background:var(--surface2);border-radius:4px;padding:10px 12px;">
        <div style="font-size:0.62rem;color:var(--muted);text-transform:uppercase;letter-spacing:0.08em;margin-bottom:4px;">Events</div>
        <div style="font-family:'Bebas Neue',sans-serif;font-size:1.8rem;line-height:1;">${playerEvents.length}</div>
      </div>
      ${champPos >= 0 ? `
      <div style="background:var(--surface2);border-radius:4px;padding:10px 12px;">
        <div style="font-size:0.62rem;color:var(--muted);text-transform:uppercase;letter-spacing:0.08em;margin-bottom:4px;">CoS Rank</div>
        <div style="font-family:'Bebas Neue',sans-serif;font-size:1.8rem;color:${isOptedIn ? 'var(--accent)' : 'var(--muted)'};line-height:1;">${isOptedIn ? '#' + (champPos+1) : '--'}</div>
        <div style="font-size:0.65rem;color:var(--faint);">${isOptedIn ? 'visible' : 'opted out'}</div>
      </div>` : ''}
    </div>
    ${mainFaction ? `<div style="font-size:0.78rem;color:var(--muted);margin-bottom:6px;">Main faction: <span style="color:var(--text);">${mainFaction}</span></div>` : ''}
    ${bestResult ? `<div style="font-size:0.78rem;color:var(--muted);">Best result: <span style="color:${bestResult.pct <= 0.1 ? 'var(--accent)' : 'var(--text)'};">${bestResult.placing}/${bestResult.total} at ${bestResult.event.replace(' -- 40k Main Event','').replace(' Grand Tournament','')}</span></div>` : ''}
    <div style="margin-top:1rem;padding-top:1rem;border-top:1px solid var(--border);">
      <div style="font-size:0.65rem;color:var(--muted);text-transform:uppercase;letter-spacing:0.08em;margin-bottom:8px;">Recent events</div>
      ${playerEvents.slice(-4).reverse().map(ev => {
        const r = ev.results.find(r => r.player === name);
        const total = ev.format === 'Teams' ? ev.totalTeams : ev.totalPlayers;
        return `<div style="display:flex;justify-content:space-between;align-items:center;padding:5px 0;border-bottom:1px solid var(--border);font-size:0.78rem;">
          <span style="color:var(--text);">${ev.name.replace(' -- 40k Main Event','').replace(' Grand Tournament',' GT')}</span>
          <span style="color:var(--muted);">${r.placing}/${total} · ${r.w}W ${r.l}L</span>
        </div>`;
      }).join('')}
    </div>`;
}

function updateCosToggleUI(isOptedIn) {
  const toggle = document.getElementById('members-cos-toggle');
  const track = document.getElementById('members-cos-track');
  const thumb = document.getElementById('members-cos-thumb');
  const label = document.getElementById('members-cos-label');
  if (!toggle) return;
  toggle.checked = isOptedIn;
  track.style.background = isOptedIn ? 'var(--accent)' : 'var(--surface2)';
  track.style.borderColor = isOptedIn ? 'var(--accent)' : 'var(--border)';
  thumb.style.background = isOptedIn ? '#fff' : 'var(--muted)';
  thumb.style.left = isOptedIn ? '23px' : '3px';
  label.textContent = isOptedIn ? 'Showing on leaderboard' : 'Show my ranking on the leaderboard';
}

async function handleCosToggle(checked) {
  const name = window._memberName;
  if (!name) return;
  const status = document.getElementById('members-cos-status');
  status.style.display = 'block';
  status.style.color = 'var(--muted)';
  status.textContent = 'Saving...';

  // Set state directly based on checkbox value -- don't toggle, set explicitly
  const optins = getCosOptins();
  if (checked) optins.add(name); else optins.delete(name);
  await saveCosOptins(optins);

  // Read back from freshly loaded attendanceData to confirm
  const confirmed = getCosOptins();
  const isOptedIn = confirmed.has(name);
  updateCosToggleUI(isOptedIn);

  status.style.color = 'var(--win)';
  status.textContent = isOptedIn
    ? '✓ You are now visible on the Champions of Shame leaderboard'
    : '✓ Removed from the leaderboard';
  setTimeout(() => { status.style.display = 'none'; }, 3000);

  // Refresh the leaderboard and stats preview
  renderLeaderboard(activeFilter);
  buildMemberStatsPreview(name);
}

function clearMemberIdentity() {
  localStorage.removeItem('pssn_member');
  window._memberName = null;
  document.getElementById('members-profile').style.display = 'none';
  // Reset all buttons
  [...D.players].forEach(p => {
    const btn = document.getElementById(`member-btn-${p.name.replace(/\s+/g,'-').toLowerCase()}`);
    if (!btn) return;
    btn.style.background = 'transparent';
    btn.style.color = 'var(--text)';
    btn.style.borderLeft = '3px solid transparent';
  });
}


// -- tab switching --
function switchTab(tab) {
  const tabs = ['stats','calendar','league','submit','members','admin'];
  tabs.forEach(t => {
    const el = document.getElementById('tab-' + t);
    if (el) el.style.display = t === tab ? '' : 'none';
  });
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  const activeBtn = document.querySelector(`.tab-btn[onclick="switchTab('${tab}')"]`);
  if (activeBtn) activeBtn.classList.add('active');
  if (tab === 'calendar') renderCalendar();
  if (tab === 'club') renderClub();
  if (tab === 'league') renderLeague();
  if (tab === 'more') { buildAwards(); buildMilestones(); }
  if (tab === 'stats') buildNowPanel();
  if (tab === 'members') initMembersTab();
  if (tab === 'submit') {
    updatePendingBadge();
    // Restore unlocked state if already authenticated this session
    if (sessionStorage.getItem('pssn_team_unlocked') === '1') {
      const gate = document.getElementById('pin-gate');
      const form = document.getElementById('submit-form');
      if (gate) gate.style.display = 'none';
      if (form) {
        form.style.display = 'block';
        renderWhosGoing();
        // Re-populate correction dropdown on each tab visit (may be empty after nav)
        populateCorrectionDropdowns();
      }
    }
  }
  if (tab === 'admin') {
    loadDbEvents();
    loadAndRenderMembers();
    updatePendingBadge();
    // Render season team manager
    setTimeout(() => renderSeasonTeamManager(), 400);
    // Set edition dropdown default based on date -- 10th before 20 Jun 2026, 11th from that date
    const edSel = document.getElementById('sched-ev-edition');
    if (edSel) {
      const launchDate = 20260620;
      const today = getTodaySortDate();
      edSel.value = '11'; // 11th Edition is now active
    }
  }
}

// -- PIN gate --
function populateCorrectionDropdowns() {
  const corrSel = document.getElementById('corr-player');
  if (corrSel) {
    const sorted = [...D.players].sort((a,b) => a.name.localeCompare(b.name));
    corrSel.innerHTML = '<option value="">Select your name...</option>';
    sorted.forEach(p => {
      const opt = document.createElement('option');
      opt.value = p.name; opt.textContent = p.name;
      corrSel.appendChild(opt);
    });
  }
  const corrFac = document.getElementById('corr-faction');
  if (corrFac && corrFac.options.length <= 1) {
    ALL_FACTIONS.forEach(f => {
      const opt = document.createElement('option');
      opt.value = f; opt.textContent = f;
      corrFac.appendChild(opt);
    });
  }
}

async function checkPin(val) {
  if (val.length < 4) return;
  if (val === TEAM_PIN) {
    document.getElementById('pin-gate').style.display = 'none';
    document.getElementById('submit-form').style.display = 'block';
    sessionStorage.setItem('pssn_team_unlocked', '1');
    // Dismiss welcome nudge when member authenticates
    const teamNudge = document.getElementById('welcome-nudge');
    if (teamNudge) teamNudge.style.display = 'none';
    // Load db events first, then render who's going with data available
    await loadDbEvents();
    renderWhosGoing();
    renderTeamsSignup();
    // Populate correction dropdowns
    populateCorrectionDropdowns();
  } else {
    document.getElementById('pin-error').style.display = 'block';
    document.getElementById('pin-input').value = '';
    setTimeout(() => { document.getElementById('pin-error').style.display = 'none'; }, 2000);
  }
}


// -- calendar --
let calView = 'upcoming';

function switchCalView(view) {
  calView = view;
  document.getElementById('cal-btn-upcoming').classList.toggle('active', view === 'upcoming');
  document.getElementById('cal-btn-past').classList.toggle('active', view === 'past');
  renderCalendar();
}

// -- Schedule Event --
function schedAutoSortDate(val) {
  const MONTHS = {jan:1,feb:2,mar:3,apr:4,may:5,jun:6,jul:7,aug:8,sep:9,oct:10,nov:11,dec:12};
  const s = val.trim().toLowerCase();
  const mDay = s.match(/(\d{1,2})[\s\u2013\-\u2013]+\d{0,2}\s*([a-z]+)\s+(\d{4})/);
  if (mDay && MONTHS[mDay[2]] && parseInt(mDay[3]) > 2020) {
    const el = document.getElementById('sched-ev-sortdate');
    if (el) el.value = parseInt(mDay[3]) * 10000 + MONTHS[mDay[2]] * 100 + parseInt(mDay[1]);
    return;
  }
  const mMon = s.match(/([a-z]+)[\s\-]+(\d{4})/);
  if (mMon && MONTHS[mMon[1]] && parseInt(mMon[2]) > 2020) {
    const el = document.getElementById('sched-ev-sortdate');
    if (el) el.value = parseInt(mMon[2]) * 10000 + MONTHS[mMon[1]] * 100 + 1;
  }
}

async function scheduleEvent() {
  const msg      = document.getElementById('sched-message');
  const name     = document.getElementById('sched-ev-name').value.trim();
  const date     = document.getElementById('sched-ev-date').value.trim();
  const sortDate = parseInt(document.getElementById('sched-ev-sortdate').value);
  const format   = document.getElementById('sched-ev-format').value;
  const players  = parseInt(document.getElementById('sched-ev-players').value) || 0;
  const bcp      = document.getElementById('sched-ev-bcp').value.trim();

  if (!name || !date || !sortDate || !format) {
    msg.style.display = 'block'; msg.style.background = 'var(--loss-bg)'; msg.style.color = 'var(--loss)';
    msg.textContent = 'Please fill in event name, date and format.'; return;
  }

  // Duplicate check
  if (dbEvents.some(e => e.name.toLowerCase() === name.toLowerCase())) {
    msg.style.display = 'block'; msg.style.background = 'var(--draw-bg)'; msg.style.color = 'var(--draw)';
    msg.textContent = `"${name}" already exists in the database.`; return;
  }

  msg.style.display = 'block'; msg.style.background = 'var(--surface2)'; msg.style.color = 'var(--muted)';
  msg.textContent = 'Saving...';

  try {
    const edition = parseInt(document.getElementById('sched-ev-edition')?.value) || ACTIVE_EDITION;
    const res = await fetch(`${API}/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        pin: getAdminPin(),
        event: { name, event_date: date, sort_date: sortDate, format, total_players: players, bcp_url: bcp, edition },
        results: []
      })
    });
    const data = await res.json();
    if (data.success) {
      msg.style.background = 'var(--win-bg)'; msg.style.color = 'var(--win)';
      msg.textContent = `✓ "${name}" added to calendar. Members can now sign up in Who's Going.`;
      // Clear form
      ['sched-ev-name','sched-ev-date','sched-ev-sortdate','sched-ev-players','sched-ev-bcp']
        .forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
      // Reload events so calendar + countdown update immediately
      await loadDbEvents();
      await loadApprovedSubmissions();
      rebuildStats();
      buildNowPanel();
      if (document.getElementById('tab-calendar')?.style.display !== 'none') renderCalendar();
      setTimeout(() => { msg.style.display = 'none'; }, 3000);
    } else {
      msg.style.background = 'var(--loss-bg)'; msg.style.color = 'var(--loss)';
      msg.textContent = 'Error: ' + (data.error || 'Unknown');
    }
  } catch(e) {
    msg.style.background = 'var(--loss-bg)'; msg.style.color = 'var(--loss)';
    msg.textContent = 'Network error -- try again.';
  }
}


// -- Calendar events from DB --
// Returns events in CALENDAR-compatible shape, sourced from dbEvents
// Falls back to CALENDAR constant if dbEvents not yet loaded
function getCalendarEvents() {
  if (!dbEvents || !dbEvents.length) {
    // dbEvents not loaded yet -- return CALENDAR as fallback
    return (typeof CALENDAR !== 'undefined' ? CALENDAR : []);
  }
  return dbEvents.map(ev => ({
    name:     ev.name,
    dates:    ev.event_date || '',
    type:     ev.format || 'GT',
    attended: Array.isArray(ev.results) && ev.results.some(r => D.players.some(p => p.name === r.player_name)),
    sortDate: ev.sort_date || 0,
    bcp:      ev.bcp_url || '',
    id:       ev.id,
  })).filter(ev => ev.sortDate > 0);
}


async function renderCalendar() {
  const el = document.getElementById('calendar-grid');
  el.innerHTML = `<div style="font-size:0.82rem;color:var(--muted);">Loading...</div>`;
  // Ensure DB events are loaded -- needed for getCalendarEvents()
  if (!dbEvents || !dbEvents.length) await loadDbEvents();
  // Load fresh attendance data so calendar shows who's going
  await loadAttendance();
  el.innerHTML = '';
  const TODAY = getTodaySortDate();

  const typeColor = { GT: 'var(--accent)', Teams: 'var(--draw)', RTT: 'var(--win)' };
  const typeBg    = { GT: 'var(--accent-bg)', Teams: 'var(--draw-bg)', RTT: 'var(--win-bg)' };

  // split and sort
  const calEvs = getCalendarEvents();
  let events = calView === 'upcoming'
    ? calEvs.filter(ev => ev.sortDate >= TODAY).sort((a,b) => a.sortDate - b.sortDate)
    : calEvs.filter(ev => ev.sortDate < TODAY).sort((a,b) => b.sortDate - a.sortDate);

  if (!events.length) {
    if (calView === 'upcoming') {
      el.innerHTML = `<div style="font-size:0.85rem;color:var(--muted);padding:1rem 0;">No upcoming events yet. Use <strong style="color:var(--text);">Admin → Schedule an Event</strong> to add the next event to the calendar.</div>`;
    } else {
      el.innerHTML = `<div style="font-size:0.85rem;color:var(--muted);padding:1rem 0;">No past events found.</div>`;
    }
    return;
  }

  // group by month
  const groups = {};
  events.forEach(ev => {
    const yr = Math.floor(ev.sortDate / 10000);
    const mo = Math.floor((ev.sortDate % 10000) / 100);
    const key = `${yr}-${String(mo).padStart(2,'0')}`;
    if (!groups[key]) groups[key] = { label: new Date(yr, mo-1, 1).toLocaleString('en-GB', {month:'long', year:'numeric'}), events: [] };
    groups[key].events.push(ev);
  });

  let html = '';
  Object.values(groups).forEach(g => {
    html += `<div style="margin-bottom:1.5rem;">
      <div style="font-size:0.7rem;font-weight:500;letter-spacing:0.1em;text-transform:uppercase;color:var(--muted);margin-bottom:8px;padding-bottom:6px;border-bottom:1px solid var(--border);">${g.label}</div>
      <div style="display:flex;flex-direction:column;gap:6px;">`;

    g.events.forEach(ev => {
      const isPast = ev.sortDate < TODAY;
      const attended = ev.attended;
      const borderCol = attended ? 'var(--accent)' : 'var(--border)';
      const borderW   = attended ? '2px' : '1px';
      const opacity   = isPast && !attended ? '0.45' : '1';

      // Who's going for this event
      const going = D.players.map(p => p.name).filter(n =>
        attendanceData[`${n}_${ev.sortDate}`] === 'yes'
      );
      const maybe = D.players.map(p => p.name).filter(n =>
        attendanceData[`${n}_${ev.sortDate}`] === 'maybe'
      );
      const notgoing = D.players.map(p => p.name).filter(n =>
        attendanceData[`${n}_${ev.sortDate}`] === 'no'
      );
      const total = going.length + maybe.length;

      const whoId = `who-${ev.sortDate}`;
      const whoHtml = (total > 0 || notgoing.length > 0) ? `
        <div style="margin-top:8px;padding-top:8px;border-top:1px solid var(--border);" id="${whoId}">
          ${going.length ? `
            <div style="margin-bottom:4px;">
              <span style="font-size:0.62rem;font-weight:500;letter-spacing:0.08em;text-transform:uppercase;color:var(--win);">Going (${going.length})</span>
              <div style="display:flex;flex-wrap:wrap;gap:4px;margin-top:3px;">
                ${going.map(n => `<span style="font-size:0.72rem;padding:2px 7px;background:var(--win-bg);border:1px solid var(--win);border-radius:3px;color:var(--win);">${n}</span>`).join('')}
              </div>
            </div>` : ''}
          ${maybe.length ? `
            <div style="margin-bottom:4px;">
              <span style="font-size:0.62rem;font-weight:500;letter-spacing:0.08em;text-transform:uppercase;color:#c9a227;">Maybe (${maybe.length})</span>
              <div style="display:flex;flex-wrap:wrap;gap:4px;margin-top:3px;">
                ${maybe.map(n => `<span style="font-size:0.72rem;padding:2px 7px;background:#2a2000;border:1px solid #c9a227;border-radius:3px;color:#c9a227;">${n}</span>`).join('')}
              </div>
            </div>` : ''}
          ${notgoing.length ? `
            <div>
              <span style="font-size:0.62rem;font-weight:500;letter-spacing:0.08em;text-transform:uppercase;color:var(--loss);">Not going (${notgoing.length})</span>
              <div style="display:flex;flex-wrap:wrap;gap:4px;margin-top:3px;">
                ${notgoing.map(n => `<span style="font-size:0.72rem;padding:2px 7px;background:var(--loss-bg);border:1px solid var(--loss);border-radius:3px;color:var(--loss);">${n}</span>`).join('')}
              </div>
            </div>` : ''}
        </div>` : '';

      // Attendance pill shown even if nobody signed up yet (for upcoming events)
      const attendanceSummary = !isPast ? `
        <div onclick="toggleCalWho('${whoId}')" style="display:flex;align-items:center;gap:5px;cursor:${total > 0 ? 'pointer' : 'default'};">
          ${going.length ? `<span style="font-size:0.7rem;padding:2px 8px;border-radius:3px;background:var(--win-bg);color:var(--win);">✓ ${going.length} going</span>` : ''}
          ${maybe.length ? `<span style="font-size:0.7rem;padding:2px 8px;border-radius:3px;background:#2a2000;color:#c9a227;">? ${maybe.length} maybe</span>` : ''}
          ${total === 0 ? `<span style="font-size:0.7rem;color:var(--faint);">No sign-ups yet</span>` : ''}
          ${total > 0 ? `<span id="${whoId}-arrow" style="font-size:0.65rem;color:var(--muted);transition:transform 0.2s;display:inline-block;">▼</span>` : ''}
        </div>` : '';

      const statusTag = attended
        ? `<span style="font-size:0.62rem;font-weight:500;padding:2px 7px;border-radius:3px;background:var(--accent-bg);color:var(--accent);letter-spacing:0.04em;">PSSN attended</span>`
        : isPast
          ? `<span style="font-size:0.62rem;font-weight:500;padding:2px 7px;border-radius:3px;background:var(--surface2);color:var(--muted);letter-spacing:0.04em;">Past</span>`
          : `<span style="font-size:0.62rem;font-weight:500;padding:2px 7px;border-radius:3px;background:var(--surface2);color:var(--muted);letter-spacing:0.04em;">Upcoming</span>`;

      const typeTag = `<span style="font-size:0.62rem;font-weight:500;padding:2px 7px;border-radius:3px;background:${typeBg[ev.type] || 'var(--surface2)'};color:${typeColor[ev.type] || 'var(--muted)'};">${ev.type}</span>`;

      html += `
        <div style="background:var(--surface);border:${borderW} solid ${borderCol};border-radius:4px;opacity:${opacity};padding:10px 14px;">
          <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;">
            <div>
              <div style="font-size:0.9rem;font-weight:400;color:var(--text);">${ev.name}</div>
              <div style="font-size:0.75rem;color:var(--muted);margin-top:2px;">${ev.dates}</div>
            </div>
            <div style="display:flex;flex-direction:column;align-items:flex-end;gap:5px;flex-shrink:0;">
              <div style="display:flex;gap:6px;align-items:center;">
                ${typeTag}
                ${statusTag}
              </div>
              ${attendanceSummary}
            </div>
          </div>
          ${whoHtml}
        </div>`;
    });
    html += `</div></div>`;
  });

  el.innerHTML = html;
}

// -- club tab --
let clubRendered = false;
function renderClub() {
  renderCountdown();
  if (!clubRendered) { renderTimeline(); clubRendered = true; }
}

function renderCountdown() {
  const el = document.getElementById('event-countdown');
  if (!el) return;
  const today = new Date();
  today.setHours(0,0,0,0);
  const todaySortDate = getTodaySortDate();
  const upcoming = getCalendarEvents().filter(ev => {
    return ev.sortDate >= todaySortDate;
  }).sort((a,b) => a.sortDate - b.sortDate);

  if (!upcoming.length) {
    if (ACTIVE_EDITION === 10) {
      el.innerHTML = `<div style="font-size:0.85rem;color:var(--muted);">10th Edition season complete. <span style="color:var(--accent);cursor:pointer;" onclick="switchEdition(11)">View 11th Edition →</span></div>`;
    } else {
      el.innerHTML = `<div style="font-size:0.85rem;color:var(--muted);">11th Edition results coming soon — first events from July 2026.</div>`;
    }
    return;
  }

  const next = upcoming[0];
  const y = Math.floor(next.sortDate/10000);
  const mo = Math.floor((next.sortDate%10000)/100)-1;
  const d = next.sortDate%100;
  const diffMs = new Date(y,mo,d) - today;
  const days = Math.ceil(diffMs / (1000*60*60*24));
  const typeColor = { GT:'var(--accent)', Teams:'var(--draw)', RTT:'var(--win)' };

  el.innerHTML = `
    <div style="background:${next.attended?'var(--accent-bg)':'var(--surface)'};border:${next.attended?'2px solid var(--accent-muted)':'1px solid var(--border)'};border-radius:6px;padding:1.25rem 1.5rem;display:flex;align-items:center;justify-content:space-between;gap:1rem;flex-wrap:wrap;margin-top:1rem;">
      <div>
        <div style="font-family:'Bebas Neue',sans-serif;font-size:1.4rem;letter-spacing:0.04em;color:var(--text);">${next.name}</div>
        <div style="font-size:0.8rem;color:var(--muted);margin-top:3px;">${next.dates}${next.bcp ? ' · <a href="' + next.bcp + '" target="_blank" rel="noopener" style="color:var(--accent);text-decoration:none;font-size:0.75rem;">BCP \u2197</a>' : ''} · <span style="color:${typeColor[next.type]}">${next.type}</span>${next.attended?' · <span style="color:var(--accent);">PSSN attending</span>':''}</div>
      </div>
      <div style="text-align:right;">
        <div style="font-family:'Bebas Neue',sans-serif;font-size:3.5rem;line-height:1;color:${days<=7?'#ff6a00':'var(--text)'};">${days}</div>
        <div style="font-size:0.72rem;color:var(--muted);letter-spacing:0.08em;text-transform:uppercase;">day${days!==1?'s':''} to go</div>
      </div>
    </div>
    ${upcoming.length>1?`<div style="font-size:0.75rem;color:var(--muted);margin-top:8px;">After that: ${upcoming.slice(1,4).map(e=>`${e.name} (${e.dates})`).join(' · ')}</div>`:''}`;
}

function renderTimeline() {
  const el = document.getElementById('season-timeline');
  if (!el) return;
  const now = new Date(); now.setHours(0,0,0,0);
  const today = now.getFullYear()*10000 + (now.getMonth()+1)*100 + now.getDate();
  const typeColor = { GT:'var(--accent)', Teams:'var(--draw)', RTT:'var(--win)' };

  el.innerHTML = `
    <div style="overflow-x:auto;padding-bottom:1rem;margin-top:1rem;">
      <div style="display:flex;align-items:flex-start;min-width:max-content;padding:1rem 0 0.5rem;">
        ${getCalendarEvents().sort((a,b)=>a.sortDate-b.sortDate).map((ev,i) => {
          const isPast = ev.sortDate < today;
          const attended = ev.attended;
          const opacity = isPast && !attended ? '0.4' : '1';
          const borderCol = attended ? 'var(--accent)' : 'var(--border)';
          const connector = i < getCalendarEvents().length-1 ? `<div style="width:20px;height:2px;background:var(--border);flex-shrink:0;margin-top:22px;"></div>` : '';
          return `<div style="display:flex;align-items:flex-start;">
            <div style="display:flex;flex-direction:column;align-items:center;width:110px;opacity:${opacity};">
              <div style="width:12px;height:12px;border-radius:50%;background:${attended?'var(--accent)':isPast?'var(--faint)':'var(--surface2)'};border:2px solid ${borderCol};margin-bottom:5px;"></div>
              <div style="background:var(--surface);border:${attended?'2px':'1px'} solid ${borderCol};border-radius:4px;padding:5px 7px;width:100%;text-align:center;">
                <div style="font-size:0.65rem;font-weight:500;color:${typeColor[ev.type]};">${ev.type}</div>
                <div style="font-size:0.68rem;color:var(--text);margin-top:1px;line-height:1.3;">${ev.name}</div>
                <div style="font-size:0.58rem;color:var(--muted);margin-top:2px;">${ev.dates.split('-')[0].trim()}</div>
              </div>
            </div>${connector}
          </div>`;
        }).join('')}
      </div>
      <div style="font-size:0.72rem;color:var(--muted);margin-top:4px;display:flex;gap:12px;flex-wrap:wrap;">
        <span style="display:flex;align-items:center;gap:4px;"><span style="width:10px;height:10px;border-radius:50%;background:var(--accent);display:inline-block;"></span>PSSN attending</span>
        <span style="display:flex;align-items:center;gap:4px;"><span style="width:10px;height:10px;border-radius:50%;background:var(--faint);display:inline-block;"></span>Past</span>
        <span style="display:flex;align-items:center;gap:4px;"><span style="width:10px;height:10px;border-radius:50%;background:var(--surface2);border:2px solid var(--border);display:inline-block;"></span>Upcoming</span>
      </div>
    </div>`;
}

// -- who's going -- API backed --

let _attendanceLastFetch = 0;
const ATTENDANCE_CACHE_TTL = 30000; // 30 seconds

async function loadAttendance(forceReload = false) {
  const now = Date.now();
  if (!forceReload && now - _attendanceLastFetch < ATTENDANCE_CACHE_TTL && Object.keys(attendanceData).length) return;
  try {
    const res = await fetch(`${API}/attendance`, { cache: 'no-store' });
    const ct = res.headers.get('content-type') || '';
    if (!res.ok || !ct.includes('application/json')) {
      console.warn('Attendance API unavailable:', res.status);
      return;
    }
    const data = await res.json();
    attendanceData = {};
    // API returns a flat key-value object: { "PlayerName_20260411": "yes", ... }
    // (not an array with an attendance key)
    if (Array.isArray(data.attendance)) {
      // Legacy array format
      data.attendance.forEach(row => {
        attendanceData[`${row.player_name}_${row.event_sort_date}`] = row.status;
      });
    } else {
      // Current flat object format
      Object.assign(attendanceData, data);
    }
    _attendanceLastFetch = Date.now();
  } catch(e) {
    console.warn('Failed to load attendance:', e.message);
  }
}

async function renderWhosGoing() {
  const el = document.getElementById('whos-going-grid');
  if (!el) return;
  el.innerHTML = `<div style="font-size:0.82rem;color:var(--muted);padding:1rem 0;">Loading...</div>`;
  if (!dbEvents || !dbEvents.length) await loadDbEvents();
  await loadAttendance();
  const now = new Date(); now.setHours(0,0,0,0);
  const today = now.getFullYear()*10000 + (now.getMonth()+1)*100 + now.getDate();
  const upcoming = getCalendarEvents().filter(ev => ev.sortDate >= today).sort((a,b) => a.sortDate - b.sortDate);
  const players = D.players.map(p => p.name).filter(Boolean).sort();

  if (!upcoming.length) {
    el.innerHTML = `<div style="font-size:0.85rem;color:var(--muted);padding:1rem 0;">
      No upcoming events to sign up for yet.
      <span style="display:block;margin-top:6px;font-size:0.78rem;">
        Use <strong>Admin → Schedule an Event</strong> to add upcoming events.
      </span>
    </div>`;
    return;
  }

  // -- Player dropdown -- pre-fill from localStorage --
  const storedMember = sessionStorage.getItem('pssn_wg_player') || localStorage.getItem('pssn_member') || '';
  const playerOptions = `<option value="">Select your name...</option>` +
    players.map(n => `<option value="${n.replace(/"/g,'&quot;')}"${n === storedMember ? ' selected' : ''}>${n}</option>`).join('');

  // -- Build accordion cards --
  function buildCards(selectedPlayer) {
    return upcoming.map((ev, idx) => {
      const going   = players.filter(n => attendanceData[`${n}_${ev.sortDate}`] === 'yes');
      const maybe   = players.filter(n => attendanceData[`${n}_${ev.sortDate}`] === 'maybe');
      const typeColors = { GT: 'var(--accent)', Teams: 'var(--draw)', RTT: 'var(--win)', Championship: 'var(--accent)', Club: 'var(--win)' };
      const typeBgs   = { GT: 'var(--accent-bg)', Teams: 'var(--draw-bg)', RTT: 'var(--win-bg)', Championship: 'var(--accent-bg)', Club: 'var(--win-bg)' };
      const tc = typeColors[ev.type] || 'var(--muted)';
      const tb = typeBgs[ev.type] || 'var(--surface2)';

      const goingChips  = going.map(n  => `<span style="font-size:0.7rem;padding:2px 8px;border-radius:10px;background:var(--win-bg);color:var(--win);border:1px solid var(--win);">${n}</span>`).join('');
      const maybeChips  = maybe.map(n  => `<span style="font-size:0.7rem;padding:2px 8px;border-radius:10px;background:var(--draw-bg);color:var(--draw);border:1px solid var(--draw);">${n}</span>`).join('');

      // Sign-up row for selected player
      const myStatus = selectedPlayer ? attendanceData[`${selectedPlayer}_${ev.sortDate}`] : null;
      const safeName = selectedPlayer ? selectedPlayer.replace(/\\/g,'\\\\').replace(/'/g,"\\'") : '';
      const signupHtml = selectedPlayer ? `
        <div style="padding:10px 14px;border-top:1px solid var(--border);display:flex;align-items:center;justify-content:space-between;gap:10px;">
          <span style="font-size:0.8rem;color:var(--muted);">Your status</span>
          <div style="display:flex;border-radius:5px;overflow:hidden;border:1px solid var(--border);">
            <button onclick="wgSetGoing('${safeName}',${ev.sortDate},'yes')" style="padding:6px 12px;font-size:0.78rem;font-weight:500;font-family:'DM Sans',sans-serif;border:none;border-right:1px solid var(--border);cursor:pointer;background:${myStatus==='yes'?'var(--win-bg)':'var(--surface2)'};color:${myStatus==='yes'?'var(--win)':'var(--muted)'};transition:all 0.1s;">✓ Going</button>
            <button onclick="wgSetGoing('${safeName}',${ev.sortDate},'maybe')" style="padding:6px 12px;font-size:0.78rem;font-weight:500;font-family:'DM Sans',sans-serif;border:none;cursor:pointer;background:${myStatus==='maybe'?'var(--draw-bg)':'var(--surface2)'};color:${myStatus==='maybe'?'var(--draw)':'var(--muted)'};transition:all 0.1s;">? Maybe</button>
          </div>
        </div>` : '';

      const attendanceBody = (going.length || maybe.length) ? `
        <div style="padding:10px 14px;display:flex;flex-wrap:wrap;gap:4px;">
          ${goingChips}${maybeChips}
        </div>` : `<div style="padding:10px 14px;font-size:0.78rem;color:var(--faint);">No sign-ups yet.</div>`;

      return `<div style="background:var(--surface);border:1px solid var(--border);border-radius:6px;margin-bottom:8px;overflow:hidden;">
        <!-- Header -- always visible -->
        <div onclick="wgToggleCard(${idx})" style="display:flex;align-items:center;gap:10px;padding:12px 14px;cursor:pointer;user-select:none;" onmouseover="this.style.background='var(--surface2)'" onmouseout="this.style.background='transparent'">
          <div style="flex:1;min-width:0;">
            <div style="font-size:0.88rem;font-weight:500;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${ev.name}</div>
            <div style="font-size:0.72rem;color:var(--muted);margin-top:2px;">${ev.dates}</div>
          </div>
          <div style="display:flex;align-items:center;gap:6px;flex-shrink:0;">
            ${going.length  ? `<span style="font-size:0.7rem;font-weight:500;padding:2px 8px;border-radius:10px;background:var(--win-bg);color:var(--win);">✓ ${going.length}</span>` : ''}
            ${maybe.length  ? `<span style="font-size:0.7rem;font-weight:500;padding:2px 8px;border-radius:10px;background:var(--draw-bg);color:var(--draw);">? ${maybe.length}</span>` : ''}
            ${!going.length && !maybe.length ? `<span style="font-size:0.7rem;color:var(--faint);">No sign-ups</span>` : ''}
            <span style="font-size:0.7rem;font-weight:500;padding:2px 7px;border-radius:3px;background:${tb};color:${tc};">${ev.type}</span>
            <span id="wg-chev-${idx}" style="font-size:0.65rem;color:var(--muted);transition:transform 0.2s;">▼</span>
          </div>
        </div>
        <!-- Body -- toggled -->
        <div id="wg-body-${idx}" style="display:none;border-top:1px solid var(--border);">
          ${attendanceBody}
          ${signupHtml}
        </div>
      </div>`;
    }).join('');
  }

  el.innerHTML = `
    <!-- Player selector -->
    <div style="margin-bottom:14px;">
      <label style="font-size:0.72rem;color:var(--muted);text-transform:uppercase;letter-spacing:0.06em;display:block;margin-bottom:5px;">Who are you?</label>
      <select id="wg-player-sel" onchange="wgOnPlayerChange(this.value)"
        style="width:100%;padding:8px 11px;background:var(--surface);border:1px solid var(--border);border-radius:5px;color:var(--text);font-family:'DM Sans',sans-serif;font-size:0.85rem;appearance:none;">
        ${playerOptions}
      </select>
    </div>
    <!-- Event accordion cards -->
    <div id="wg-cards">${buildCards(storedMember)}</div>
    <div style="font-size:0.72rem;color:var(--muted);margin-top:6px;">Sign-ups are shared across all devices.</div>`;

  // Expose buildCards so wgOnPlayerChange can re-render cards
  window._wgBuildCards = buildCards;
  window._wgUpcoming = upcoming;
}

function wgToggleCard(idx) {
  const body  = document.getElementById('wg-body-' + idx);
  const chev  = document.getElementById('wg-chev-' + idx);
  if (!body) return;
  const open = body.style.display !== 'none';
  body.style.display = open ? 'none' : 'block';
  if (chev) chev.style.transform = open ? '' : 'rotate(180deg)';
}

function wgOnPlayerChange(name) {
  if (name) {
    sessionStorage.setItem('pssn_wg_player', name);
    localStorage.setItem('pssn_member', name); // keep in sync across tabs
  }
  const cardsEl = document.getElementById('wg-cards');
  if (cardsEl && window._wgBuildCards) {
    // Remember which cards were open
    const openCards = (window._wgUpcoming || []).map((_,i) => {
      const b = document.getElementById('wg-body-' + i);
      return b && b.style.display !== 'none';
    });
    cardsEl.innerHTML = window._wgBuildCards(name);
    // Restore open state
    openCards.forEach((wasOpen, i) => {
      if (wasOpen) {
        const body = document.getElementById('wg-body-' + i);
        const chev = document.getElementById('wg-chev-' + i);
        if (body) body.style.display = 'block';
        if (chev) chev.style.transform = 'rotate(180deg)';
      }
    });
  }
}

async function wgSetGoing(name, sortDate, status) {
  await setGoing(name, sortDate, status);
  // After setGoing re-renders, restore the card that was open
  // setGoing calls renderWhosGoing() which rebuilds everything --
  // we open the card for this event after re-render
  const idx = (window._wgUpcoming || []).findIndex(ev => ev.sortDate === sortDate);
  if (idx >= 0) {
    const body = document.getElementById('wg-body-' + idx);
    const chev = document.getElementById('wg-chev-' + idx);
    if (body) { body.style.display = 'block'; }
    if (chev) { chev.style.transform = 'rotate(180deg)'; }
  }
}

async function setGoing(name, sortDate, status) {
  const key = `${name}_${sortDate}`;
  const current = attendanceData[key];
  try {
    let res;
    if (current === status) {
      res = await fetch(`${API}/attendance`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ player_name: name, event_sort_date: sortDate, pin: TEAM_PIN })
      });
    } else {
      res = await fetch(`${API}/attendance`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ player_name: name, event_sort_date: sortDate, status, pin: TEAM_PIN })
      });
    }
    if (!res.ok) {
      console.error('Attendance write failed:', res.status);
      return; // don't re-render with stale state
    }
    await loadAttendance(true); // force reload so tick updates immediately
    await renderWhosGoing();
  } catch(e) {
    console.error('Failed to update attendance', e);
  }
}

// -- who's going sub-tabs --
function switchWgTab(tab) {
  ['individual','teams'].forEach(t => {
    document.getElementById('wg-' + t).style.display = t === tab ? '' : 'none';
    document.getElementById('wg-btn-' + t).classList.toggle('active', t === tab);
  });
  if (tab === 'teams') renderTeamsSignup();
}

// -- Data corrections --

async function loadCorrectionEvents() {
  const name = document.getElementById('corr-player').value;
  const evWrap = document.getElementById('corr-events-wrap');
  const evSel = document.getElementById('corr-event');
  const curWrap = document.getElementById('corr-current-wrap');
  const fldWrap = document.getElementById('corr-fields-wrap');

  curWrap.style.display = 'none';
  fldWrap.style.display = 'none';
  evSel.innerHTML = '<option value="">Loading events...</option>';

  if (!name) { evWrap.style.display = 'none'; return; }

  try {
    // Always fetch from API -- D.events is empty since migration
    const res = await fetch(`${API}/events`);
    const data = await res.json();
    const allEvents = data.events || [];

    const playerEvents = allEvents.filter(ev =>
      (ev.results || []).some(r => r.player_name === name)
    ).sort((a, b) => (b.sort_date || 0) - (a.sort_date || 0));

    evSel.innerHTML = '<option value="">Select event...</option>';
    if (!playerEvents.length) { evWrap.style.display = 'none'; return; }

    playerEvents.forEach(ev => {
      const opt = document.createElement('option');
      opt.value = ev.name;
      opt.textContent = `${ev.name} (${ev.event_date})`;
      opt.dataset.eventId = ev.id;
      evSel.appendChild(opt);
    });
    evWrap.style.display = 'block';

    // Cache for loadCorrectionCurrent
    window._corrEventsCache = allEvents;
  } catch(e) {
    evSel.innerHTML = '<option value="">Could not load events</option>';
    console.warn('loadCorrectionEvents error:', e);
  }
}

function loadCorrectionCurrent() {
  const name = document.getElementById('corr-player').value;
  const evName = document.getElementById('corr-event').value;
  const curWrap = document.getElementById('corr-current-wrap');
  const fldWrap = document.getElementById('corr-fields-wrap');
  const curEl = document.getElementById('corr-current');

  if (!evName) { curWrap.style.display = 'none'; fldWrap.style.display = 'none'; return; }

  // Use cached events from API fetch in loadCorrectionEvents
  const allEvents = window._corrEventsCache || [];
  const ev = allEvents.find(e => e.name === evName);
  const r = (ev?.results || []).find(r => r.player_name === name);

  if (!r) { curWrap.style.display = 'none'; fldWrap.style.display = 'none'; return; }

  const total = ev.format === 'Teams' ? ev.total_teams : ev.total_players;
  curEl.innerHTML = `
    <div style="display:flex;flex-wrap:wrap;gap:12px;align-items:center;">
      <span style="color:var(--text);">${r.faction}</span>
      <span style="color:var(--muted);">Placing: ${r.place}/${total}</span>
      <span style="display:flex;gap:4px;">
        <span style="font-size:0.7rem;padding:2px 6px;border-radius:3px;background:var(--win-bg);color:var(--win);">${r.wins}W</span>
        <span style="font-size:0.7rem;padding:2px 6px;border-radius:3px;background:var(--loss-bg);color:var(--loss);">${r.losses}L</span>
        ${r.draws > 0 ? `<span style="font-size:0.7rem;padding:2px 6px;border-radius:3px;background:#152030;color:var(--draw);">${r.draws}D</span>` : ''}
      </span>
      ${r.subteam ? `<span style="color:var(--muted);font-size:0.78rem;">${r.subteam}</span>` : ''}
    </div>`;

  // Pre-fill correction fields with current DB values
  document.getElementById('corr-w').value = r.wins;
  document.getElementById('corr-l').value = r.losses;
  document.getElementById('corr-d').value = r.draws;
  document.getElementById('corr-placing').value = r.place;
  const facSel = document.getElementById('corr-faction');
  facSel.value = r.faction;

  // Store result ID for the correction submission
  window._corrResultId = r.id;
  window._corrCurrent = { faction: r.faction, w: r.wins, l: r.losses, d: r.draws, placing: r.place };

  curWrap.style.display = 'block';
  fldWrap.style.display = 'block';
}

async function submitCorrection() {
  const msg = document.getElementById('corr-message');
  const player = document.getElementById('corr-player').value;
  const evName = document.getElementById('corr-event').value;
  const note = document.getElementById('corr-note').value.trim();

  if (!player || !evName) {
    msg.style.display = 'block'; msg.style.color = 'var(--loss)';
    msg.textContent = 'Please select your name and event.'; return;
  }
  if (!note) {
    msg.style.display = 'block'; msg.style.color = 'var(--loss)';
    msg.textContent = 'Please add a note explaining what\'s wrong.'; return;
  }

  const current = window._corrCurrent || {};

  const correction = {
    player, evName,
    current: { faction: current.faction, w: current.w, l: current.l, d: current.d, placing: current.placing },
    proposed: {
      faction: document.getElementById('corr-faction').value || current.faction,
      w: parseInt(document.getElementById('corr-w').value) ?? current.w,
      l: parseInt(document.getElementById('corr-l').value) ?? current.l,
      d: parseInt(document.getElementById('corr-d').value) ?? current.d,
      placing: parseInt(document.getElementById('corr-placing').value) || current.placing,
    },
    note,
    submittedAt: new Date().toISOString(),
    status: 'pending'
  };

  // Save using attendance API -- key: _corr_TIMESTAMP
  const ts = Date.now();
  try {
    msg.style.display = 'block'; msg.style.color = 'var(--muted)';
    msg.textContent = 'Submitting...';
    const res = await fetch(`${API}/attendance`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        player_name: `_corr_${ts}`,
        event_sort_date: 19700101,
        status: JSON.stringify(correction),
        pin: TEAM_PIN
      })
    });
    const data = await res.json();
    if (data.success) {
      msg.style.color = 'var(--win)';
      msg.textContent = '✓ Correction submitted -- the admin will review it shortly.';
      document.getElementById('corr-note').value = '';
      document.getElementById('corr-player').value = '';
      document.getElementById('corr-events-wrap').style.display = 'none';
      document.getElementById('corr-current-wrap').style.display = 'none';
      document.getElementById('corr-fields-wrap').style.display = 'none';
    } else {
      msg.style.color = 'var(--loss)';
      msg.textContent = 'Error: ' + (data.error || 'Unknown');
    }
  } catch(e) {
    msg.style.color = 'var(--loss)';
    msg.textContent = 'Network error -- try again.';
  }
}


// -- Pending result submissions (from members) --
async function loadResultSubmissions() {
  const el = document.getElementById('sheet-submissions');
  if (!el) return;
  try {
    const res = await fetch(`${API}/submissions?pin=${encodeURIComponent(getAdminPin())}`);
    const ct = res.headers.get('content-type') || '';
    if (!res.ok || !ct.includes('application/json')) {
      el.innerHTML = `<div style="font-size:0.82rem;color:var(--muted);">Could not load submissions.</div>`;
      return;
    }
    const data = await res.json();
    const pending = (data.submissions || []).filter(s => !s.approved);
    updatePendingBadge();
    if (!pending.length) {
      el.innerHTML = `<div style="font-size:0.85rem;color:var(--muted);">No pending result submissions.</div>`;
      return;
    }
    el.innerHTML = pending.map(s => `
      <div style="background:var(--surface);border:1px solid var(--border);border-radius:6px;padding:12px 14px;margin-bottom:10px;">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px;flex-wrap:wrap;">
          <div>
            <div style="font-size:0.9rem;font-weight:400;color:var(--text);">
              ${s.player_name} -- <span style="color:var(--muted);">${s.event_name}</span>
              <span style="font-size:0.65rem;background:var(--surface2);padding:1px 6px;border-radius:3px;margin-left:6px;">${s.event_format}</span>
            </div>
            <div style="font-size:0.78rem;color:var(--muted);margin-top:4px;">
              ${s.faction} · ${s.place || '?'}/${s.total_players || '?'} · ${s.wins}W ${s.losses}L ${s.draws}D
              ${s.subteam ? ` · <span style="color:var(--text);">${s.subteam}</span>` : ''}
            </div>
            <div style="font-size:0.65rem;color:var(--faint);margin-top:2px;">
              Submitted ${new Date(s.submitted_at).toLocaleDateString('en-GB', {day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'})} · <span style="color:var(--accent);">${timeAgo(s.submitted_at)}</span>
            </div>
          </div>
          <div style="display:flex;gap:6px;flex-shrink:0;">
            <button onclick="approveResultSubmission(${s.id})"
              style="font-size:0.72rem;padding:4px 12px;background:var(--win-bg);border:1px solid var(--win);border-radius:3px;color:var(--win);cursor:pointer;"
              onmouseover="this.style.opacity='0.8'" onmouseout="this.style.opacity='1'">
              ✓ Approve
            </button>
            <button onclick="rejectResultSubmission(${s.id})"
              style="font-size:0.72rem;padding:4px 12px;background:transparent;border:1px solid var(--border);border-radius:3px;color:var(--muted);cursor:pointer;"
              onmouseover="this.style.borderColor='var(--loss)';this.style.color='var(--loss)'"
              onmouseout="this.style.borderColor='var(--border)';this.style.color='var(--muted)'">
              ✗ Reject
            </button>
          </div>
        </div>
        <div id="sub-msg-${s.id}" style="display:none;margin-top:8px;font-size:0.72rem;padding:6px 10px;border-radius:4px;"></div>
      </div>`).join('');
  } catch(e) {
    el.innerHTML = `<div style="font-size:0.82rem;color:var(--loss);">Error loading submissions.</div>`;
  }
}

async function approveResultSubmission(id) {
  if (!confirm('Approve this result and add it to the stats?')) return;
  const msg = document.getElementById(`sub-msg-${id}`);
  if (msg) { msg.style.display='block'; msg.style.background='var(--surface2)'; msg.style.color='var(--muted)'; msg.textContent='Approving...'; }
  try {
    const res = await fetch(`${API}/submissions`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin: getAdminPin(), id, approved: true })
    });
    const data = await res.json();
    if (data.success) {
      if (msg) { msg.style.background='var(--win-bg)'; msg.style.color='var(--win)'; msg.textContent='✓ Approved and added to results.'; }
      setTimeout(() => loadResultSubmissions(), 1200);
      updatePendingBadge();
    } else {
      if (msg) { msg.style.background='var(--loss-bg)'; msg.style.color='var(--loss)'; msg.textContent='Error: ' + (data.error||'Unknown'); }
    }
  } catch(e) {
    if (msg) { msg.style.background='var(--loss-bg)'; msg.style.color='var(--loss)'; msg.textContent='Network error.'; }
  }
}

async function rejectResultSubmission(id) {
  if (!confirm('Reject and delete this submission?')) return;
  const msg = document.getElementById(`sub-msg-${id}`);
  try {
    const res = await fetch(`${API}/submissions`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin: getAdminPin(), id, approved: false })
    });
    const data = await res.json();
    if (data.success) setTimeout(() => loadResultSubmissions(), 600);
    updatePendingBadge();
  } catch(e) { console.error(e); }
}

// -- Pending badge -- shows count on Submissions tab button --
let _badgeLastFetch = 0;
async function updatePendingBadge() {
  const badge = document.getElementById('pending-badge');
  if (!badge) return;
  // Only fetch if we have an admin PIN -- otherwise badge is irrelevant
  if (!getAdminPin()) return;
  try {
    const subRes = await fetch(`${API}/submissions?pin=${encodeURIComponent(getAdminPin())}`);
    const subData = await subRes.json();
    const pendingSubs = (subData.submissions || []).filter(s => !s.approved).length;

    // Use cached attendanceData if fresh (within 60s), else fetch
    const now = Date.now();
    if (!Object.keys(attendanceData).length || now - _badgeLastFetch > 60000) {
      await loadAttendance();
      _badgeLastFetch = now;
    }
    const pendingCorrs = Object.entries(attendanceData)
      .filter(([k, v]) => {
        if (!k.startsWith('_corr_') && !k.startsWith('_pending_event_')) return false;
        try { return JSON.parse(v).status === 'pending'; } catch(e) { return false; }
      }).length;

    const total = pendingSubs + pendingCorrs;
    badge.style.display = total > 0 ? 'inline' : 'none';
    if (total > 0) badge.textContent = total;
  } catch(e) {
    badge.style.display = 'none';
  }
}

function buildAdminTriage() {
  const el = document.getElementById('admin-triage');
  if (!el) return;

  // Count result subs from the sheet-submissions DOM (cards rendered by loadResultSubmissions)
  // Each pending card has a sub-msg-N element; count those as a proxy for pending count
  const pendingSubs = document.querySelectorAll('#sheet-submissions [id^="sub-msg-"]').length;

  const pendingCorrs = Object.entries(attendanceData)
    .filter(([k,v]) => { if (!k.startsWith('_corr_')) return false; try { return JSON.parse(v).status==='pending'; } catch(e){return false;} }).length;

  const pendingEvents = Object.entries(attendanceData)
    .filter(([k,v]) => { if (!k.startsWith('_pending_event_')) return false; try { return JSON.parse(v).status==='pending'; } catch(e){return false;} }).length;

  const total = pendingSubs + pendingCorrs + pendingEvents;

  // Rebuild pending badge count
  const badge = document.getElementById('pending-badge');
  if (badge) {
    badge.style.display = total > 0 ? 'inline' : 'none';
    if (total > 0) badge.textContent = total;
  }

  if (total === 0) {
    el.innerHTML = `
      <div style="display:flex;align-items:center;gap:10px;padding:12px 16px;background:var(--surface);border:1px solid var(--border);border-radius:6px;border-left:3px solid var(--win);">
        <span style="font-size:1rem;">✓</span>
        <div>
          <div style="font-size:0.85rem;color:var(--text);font-weight:500;">All clear</div>
          <div style="font-size:0.75rem;color:var(--muted);">No pending submissions, corrections, or events.</div>
        </div>
      </div>`;
    return;
  }

  const items = [];
  if (pendingSubs > 0)    items.push(`<span style="color:var(--loss);">${pendingSubs} result submission${pendingSubs>1?'s':''}</span>`);
  if (pendingEvents > 0)  items.push(`<span style="color:var(--draw);">${pendingEvents} event submission${pendingEvents>1?'s':''}</span>`);
  if (pendingCorrs > 0)   items.push(`<span style="color:var(--accent);">${pendingCorrs} correction${pendingCorrs>1?'s':''}</span>`);

  el.innerHTML = `
    <div style="padding:12px 16px;background:var(--surface);border:1px solid var(--border);border-radius:6px;border-left:3px solid var(--loss);">
      <div style="font-size:0.7rem;font-weight:500;letter-spacing:0.1em;text-transform:uppercase;color:var(--muted);margin-bottom:6px;">Needs attention</div>
      <div style="font-size:0.88rem;color:var(--text);line-height:1.8;">${items.join(' &nbsp;·&nbsp; ')}</div>
      <div style="font-size:0.72rem;color:var(--faint);margin-top:6px;">Scroll down to review each section.</div>
    </div>`;
}

async function loadAdminCorrections() {
  const el = document.getElementById('admin-corrections');
  if (!el) return;
  await loadAttendance(true); // always force fresh fetch for admin view

  const corrections = Object.entries(attendanceData)
    .filter(([k]) => k.startsWith('_corr_'))
    .map(([k, v]) => {
      try { return { key: k, ts: parseInt(k.replace('_corr_','')), ...JSON.parse(v) }; }
      catch(e) { return null; }
    })
    .filter(Boolean)
    .filter(c => c.status === 'pending')
    .sort((a, b) => b.ts - a.ts);

  if (!corrections.length) {
    el.innerHTML = `<div style="font-size:0.85rem;color:var(--muted);">No pending corrections.</div>`;
    return;
  }

  el.innerHTML = corrections.map(c => {
    const date = new Date(c.submittedAt).toLocaleDateString('en-GB', { day:'numeric', month:'short', hour:'2-digit', minute:'2-digit' });
    const changes = [];
    if (c.proposed.faction !== c.current.faction) changes.push(`Faction: ${c.current.faction} → <strong>${c.proposed.faction}</strong>`);
    if (c.proposed.w !== c.current.w) changes.push(`Wins: ${c.current.w} → <strong>${c.proposed.w}</strong>`);
    if (c.proposed.l !== c.current.l) changes.push(`Losses: ${c.current.l} → <strong>${c.proposed.l}</strong>`);
    if (c.proposed.d !== c.current.d) changes.push(`Draws: ${c.current.d} → <strong>${c.proposed.d}</strong>`);
    if (c.proposed.placing !== c.current.placing) changes.push(`Placing: ${c.current.placing} → <strong>${c.proposed.placing}</strong>`);
    const keyStr = c.key.replace(/'/g, "\\'");

    return `
      <div style="background:var(--surface);border:1px solid var(--border);border-radius:6px;padding:12px 14px;margin-bottom:10px;">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px;flex-wrap:wrap;">
          <div>
            <div style="font-size:0.9rem;font-weight:400;color:var(--text);">${c.player} -- <span style="color:var(--muted);">${c.evName}</span></div>
            <div style="font-size:0.72rem;color:var(--faint);margin-top:2px;">Submitted ${date} · <span style="color:var(--accent);">${timeAgo(c.submittedAt)}</span></div>
          </div>
          <div style="display:flex;gap:6px;">
            <button onclick="approveCorrection('${keyStr}')"
              style="font-size:0.72rem;padding:4px 12px;background:var(--win-bg);border:1px solid var(--win);border-radius:3px;color:var(--win);cursor:pointer;"
              onmouseover="this.style.opacity='0.8'" onmouseout="this.style.opacity='1'">
              ✓ Approve
            </button>
            <button onclick="dismissCorrection('${keyStr}')"
              style="font-size:0.72rem;padding:4px 12px;background:transparent;border:1px solid var(--border);border-radius:3px;color:var(--muted);cursor:pointer;"
              onmouseover="this.style.borderColor='var(--loss)';this.style.color='var(--loss)'"
              onmouseout="this.style.borderColor='var(--border)';this.style.color='var(--muted)'">
              Dismiss
            </button>
          </div>
        </div>
        ${changes.length ? `
          <div style="margin-top:10px;padding-top:8px;border-top:1px solid var(--border);">
            <div style="font-size:0.65rem;color:var(--muted);text-transform:uppercase;letter-spacing:0.08em;margin-bottom:5px;">Proposed changes</div>
            ${changes.map(ch => `<div style="font-size:0.8rem;color:var(--text);padding:2px 0;">${ch}</div>`).join('')}
          </div>` : ''}
        <div style="margin-top:8px;padding:8px 10px;background:var(--surface2);border-radius:4px;font-size:0.8rem;color:var(--muted);">
          <span style="color:var(--text);">Note:</span> ${c.note}
        </div>
        <div id="corr-approve-msg-${c.ts}" style="display:none;margin-top:8px;font-size:0.72rem;padding:8px 10px;background:var(--win-bg);border:1px solid var(--win);border-radius:4px;color:var(--win);"></div>
      </div>`;
  }).join('');
}

async function approveCorrection(key) {
  const raw = attendanceData[key];
  if (!raw) return;
  const dbPlayerName = key.replace(/_19700101$/, '');

  try {
    const c = JSON.parse(raw);
    const { player, evName, proposed } = c;

    // 1. Write correction to event_results in Neon
    // Find the event_id by fetching events API
    try {
      const evRes = await fetch(`${API}/events`);
      const evData = await evRes.json();
      const dbEv = (evData.events || []).find(e =>
        e.name.toLowerCase() === evName.toLowerCase()
      );
      if (dbEv) {
        const dbResult = (dbEv.results || []).find(r => r.player_name === player);
        if (dbResult) {
          await fetch(`${API}/events`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              pin: getAdminPin(),
              resultId: dbResult.id,
              updates: {
                ...(proposed.faction !== undefined && { faction: proposed.faction }),
                ...(proposed.w !== undefined && { wins: proposed.w }),
                ...(proposed.l !== undefined && { losses: proposed.l }),
                ...(proposed.d !== undefined && { draws: proposed.d }),
                ...(proposed.placing !== undefined && { place: proposed.placing }),
              }
            })
          });
        }
      }
    } catch(dbErr) {
      console.warn('Could not write correction to DB:', dbErr);
    }

    // 2. Apply change to D.events in memory for immediate UI update
    // D.events uses DB field names (player_name, wins, losses, draws, place)
    const ev = D.events.find(e => e.name === evName);
    if (ev) {
      const r = ev.results.find(r => r.player_name === player);
      if (r) {
        if (proposed.faction !== undefined) r.faction = proposed.faction;
        if (proposed.w !== undefined) r.wins = proposed.w;
        if (proposed.l !== undefined) r.losses = proposed.l;
        if (proposed.d !== undefined) r.draws = proposed.d;
        if (proposed.placing !== undefined) r.place = proposed.placing;
      }
    }

    // 3. Reload stats from DB -- reuse already-fetched event data if possible
    // loadApprovedSubmissions will fetch events; cache the result for correction form reuse
    await loadApprovedSubmissions();
    rebuildStats();

    // 4. Mark as approved in attendance DB
    c.status = 'approved';
    await fetch(`${API}/attendance`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ player_name: dbPlayerName, event_sort_date: 19700101, status: JSON.stringify(c), pin: getAdminPin() })
    });

    await loadAdminCorrections();

  } catch(e) {
    console.error('Failed to approve correction', e);
  }
}

async function dismissCorrection(key) {
  const raw = attendanceData[key];
  if (!raw) return;
  const dbPlayerName = key.replace(/_19700101$/, '');
  try {
    const c = JSON.parse(raw);
    c.status = 'dismissed';
    await fetch(`${API}/attendance`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        player_name: dbPlayerName,
        event_sort_date: 19700101,
        status: JSON.stringify(c),
        pin: getAdminPin()
      })
    });
    await loadAdminCorrections();
  } catch(e) {
    console.error('Failed to dismiss correction', e);
  }
}

// -- Pending event submissions --

async function loadAdminEventSubmissions() {
  const el = document.getElementById('admin-event-submissions');
  if (!el) return;
  await loadAttendance(true);

  const submissions = Object.entries(attendanceData)
    .filter(([k]) => k.startsWith('_pending_event_'))
    .map(([k, v]) => {
      try { return { key: k, ts: parseInt(k.replace('_pending_event_', '')), ...JSON.parse(v) }; }
      catch(e) { return null; }
    })
    .filter(Boolean)
    .filter(s => s.status === 'pending')
    .sort((a, b) => b.ts - a.ts);

  if (!submissions.length) {
    el.innerHTML = `<div style="font-size:0.85rem;color:var(--muted);">No pending event submissions.</div>`;
    return;
  }

  el.innerHTML = submissions.map(s => {
    const date = new Date(s.submittedAt).toLocaleDateString('en-GB', { day:'numeric', month:'short', hour:'2-digit', minute:'2-digit' });
    const ev = s.event || {};
    const r = s.result || {};
    const keyStr = s.key.replace(/'/g, "\\'");

    return `
      <div style="background:var(--surface);border:1px solid var(--border);border-radius:6px;padding:12px 14px;margin-bottom:10px;">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px;flex-wrap:wrap;">
          <div>
            <div style="font-size:0.9rem;font-weight:400;color:var(--text);">${ev.name || 'Unknown event'} <span style="font-size:0.72rem;background:var(--surface2);padding:1px 6px;border-radius:3px;color:var(--muted);">${ev.format||''}</span></div>
            <div style="font-size:0.72rem;color:var(--muted);margin-top:3px;">${ev.event_date||''} · ${ev.total_players||0} players${ev.bcp_url ? ` · <a href="${ev.bcp_url}" target="_blank" style="color:var(--accent);">BCP ↗</a>` : ''}</div>
            <div style="font-size:0.78rem;color:var(--text);margin-top:6px;">
              Submitted by <strong>${r.player_name||'?'}</strong> -- ${r.faction||'?'} · ${r.placing||'?'}th · ${r.wins||0}W ${r.losses||0}L ${r.draws||0}D
            </div>
            <div style="font-size:0.65rem;color:var(--faint);margin-top:2px;">Submitted ${date} · <span style="color:var(--accent);">${timeAgo(s.submittedAt)}</span></div>
          </div>
          <div style="display:flex;gap:6px;flex-shrink:0;">
            <button onclick="approveEventSubmission('${keyStr}')"
              style="font-size:0.72rem;padding:4px 12px;background:var(--win-bg);border:1px solid var(--win);border-radius:3px;color:var(--win);cursor:pointer;"
              onmouseover="this.style.opacity='0.8'" onmouseout="this.style.opacity='1'">
              ✓ Approve
            </button>
            <button onclick="dismissEventSubmission('${keyStr}')"
              style="font-size:0.72rem;padding:4px 12px;background:transparent;border:1px solid var(--border);border-radius:3px;color:var(--muted);cursor:pointer;"
              onmouseover="this.style.borderColor='var(--loss)';this.style.color='var(--loss)'"
              onmouseout="this.style.borderColor='var(--border)';this.style.color='var(--muted)'">
              Dismiss
            </button>
          </div>
        </div>
        <div id="ev-sub-msg-${s.ts}" style="display:none;margin-top:8px;font-size:0.72rem;padding:8px 10px;background:var(--win-bg);border:1px solid var(--win);border-radius:4px;color:var(--win);"></div>
      </div>`;
  }).join('');
}

async function approveEventSubmission(key) {
  const raw = attendanceData[key];
  if (!raw) return;
  const dbPlayerName = key.replace(/_19700101$/, '');
  const ts = parseInt(key.replace('_pending_event_', ''));

  try {
    const s = JSON.parse(raw);
    const msgEl = document.getElementById(`ev-sub-msg-${ts}`);
    if (msgEl) { msgEl.style.display = 'block'; msgEl.textContent = 'Creating event...'; }

    // Create event via admin API
    const res = await fetch(`${API}/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        pin: getAdminPin(),
        event: s.event,
        results: [s.result]
      })
    });
    const data = await res.json();

    if (data.success) {
      // Mark as approved in DB
      s.status = 'approved';
      await fetch(`${API}/attendance`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ player_name: dbPlayerName, event_sort_date: 19700101, status: JSON.stringify(s) , pin: getAdminPin() })
      });
      await loadApprovedSubmissions();
      rebuildStats();
      buildNowPanel();
      await loadDbEvents();
      await loadAdminEventSubmissions();
    } else {
      if (msgEl) { msgEl.textContent = 'Error: ' + (data.error || 'Unknown'); }
    }
  } catch(e) {
    console.error('Failed to approve event submission', e);
  }
}

async function dismissEventSubmission(key) {
  const raw = attendanceData[key];
  if (!raw) return;
  const dbPlayerName = key.replace(/_19700101$/, '');
  try {
    const s = JSON.parse(raw);
    s.status = 'dismissed';
    await fetch(`${API}/attendance`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ player_name: dbPlayerName, event_sort_date: 19700101, status: JSON.stringify(s), pin: getAdminPin() })
    });
    await loadAdminEventSubmissions();
  } catch(e) {
    console.error('Failed to dismiss event submission', e);
  }
}

// -- ITT teams sign-up --
// Default teams seeded from the last recorded ITT (Winter ITT Feb 2026)
const DEFAULT_ITT_TEAMS = [
  {
    name: 'The Sh[a]meful Suspects',
    players: ['Cayleb Langhals', 'Daniel Green', 'Anthony Keen', 'Alex Ford', 'Matt Whiteley']
  },
  {
    name: "[D]a Empuror's Shamepions",
    players: ['Tim Waters', 'Samuel Francis', 'Guy Miscampbell', 'Henry Bamford', 'Chris Enderby']
  },
  {
    name: '[E]verlasting Shame',
    players: ['Matthew Yeoh', 'Nora Tinfou', 'Harvey Rudden', 'Spencer James', 'Artur Tokarski']
  }
];

// In-memory team state (loaded from attendanceData on render)
// Key format: team_TEAMNAME_SORTDATE → JSON array of player names
// Key format: team_list_SORTDATE → JSON array of team names

async function saveTeamData(sortDate, teams) {
  const encoded = JSON.stringify(teams);
  // Optimistically update both key formats in memory so re-render is instant
  attendanceData[`_teams_${sortDate}`] = encoded;
  attendanceData[`_teams_${sortDate}_${sortDate}`] = encoded;
  try {
    await fetch(`${API}/attendance`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        player_name: `_teams_${sortDate}`,
        event_sort_date: sortDate,
        status: encoded,
        pin: TEAM_PIN
      })
    });
    await loadAttendance(true); // force cache bypass so we get fresh server state
  } catch(e) {
    console.error('Failed to save team data', e);
  }
}

// -- Season Team Manager: renders all ITT events and their team data --
async function renderSeasonTeamManager() {
  const el = document.getElementById('season-team-manager');
  if (!el) return;
  el.innerHTML = '<div style="color:var(--muted);font-size:0.82rem;">Loading...</div>';

  if (!dbEvents || !dbEvents.length) await loadDbEvents();
  await loadAttendance(true);

  const ittEvents = dbEvents
    .filter(e => e.format === 'Teams')
    .sort((a, b) => (b.sort_date || 0) - (a.sort_date || 0));

  if (!ittEvents.length) {
    el.innerHTML = '<div style="color:var(--muted);font-size:0.82rem;">No Teams events found.</div>';
    return;
  }

  el.innerHTML = ittEvents.map(ev => {
    const sd = ev.sort_date;
    const rawA = attendanceData[`_teams_${sd}`];
    const rawB = attendanceData[`_teams_${sd}_${sd}`];
    let teamsA = null, teamsB = null;
    try { if (rawA) teamsA = JSON.parse(rawA); } catch(e) {}
    try { if (rawB) teamsB = JSON.parse(rawB); } catch(e) {}

    const hasBoth = teamsA && teamsB;
    const teams = getTeamsForEvent(sd); // already merges both keys
    const totalPlayers = teams.reduce((s, t) => s + t.players.length, 0);
    const hasData = rawA || rawB;

    const statusDot = !hasData
      ? `<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:var(--muted);margin-right:6px;"></span>`
      : hasBoth
        ? `<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:var(--warn);margin-right:6px;" title="Duplicate keys exist"></span>`
        : `<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:var(--win);margin-right:6px;"></span>`;

    const teamRows = hasData ? teams.map(t => `
      <div style="display:flex;align-items:flex-start;gap:10px;padding:6px 0;border-bottom:1px solid var(--faint);">
        <div style="font-size:0.78rem;font-weight:500;color:var(--text);min-width:160px;flex-shrink:0;">${t.name}</div>
        <div style="font-size:0.72rem;color:var(--muted);flex:1;line-height:1.6;">
          ${t.players.length ? t.players.join(', ') : '<em>No players assigned</em>'}
        </div>
        <div style="font-size:0.7rem;color:var(--muted);flex-shrink:0;">${t.players.length}p</div>
      </div>`).join('') : `<div style="font-size:0.75rem;color:var(--muted);padding:8px 0;font-style:italic;">No team data saved for this event</div>`;

    const mergeBtn = hasBoth ? `
      <button onclick="adminMergeTeams(${sd})"
        style="font-size:0.72rem;padding:3px 10px;background:rgba(232,184,60,0.15);color:var(--warn);border:1px solid rgba(232,184,60,0.3);border-radius:3px;cursor:pointer;margin-left:8px;">
        Merge duplicates
      </button>` : '';

    return `
      <div style="background:var(--surface);border:1px solid var(--border);border-radius:6px;margin-bottom:8px;overflow:hidden;">
        <div style="display:flex;align-items:center;justify-content:space-between;padding:10px 14px;cursor:pointer;gap:8px;"
          onclick="this.nextElementSibling.style.display=this.nextElementSibling.style.display==='none'?'block':'none';">
          <div style="display:flex;align-items:center;gap:4px;min-width:0;">
            ${statusDot}
            <span style="font-size:0.85rem;font-weight:500;color:var(--text);">${ev.name}</span>
            <span style="font-size:0.72rem;color:var(--muted);margin-left:6px;">${ev.event_date}</span>
            ${mergeBtn}
          </div>
          <div style="display:flex;align-items:center;gap:12px;flex-shrink:0;">
            <span style="font-size:0.72rem;color:var(--muted);">${hasData ? `${teams.length} teams · ${totalPlayers} players` : 'no data'}</span>
            <span style="font-size:0.75rem;color:var(--muted);">▼</span>
          </div>
        </div>
        <div style="display:none;padding:0 14px 12px;border-top:1px solid var(--faint);">
          ${teamRows}
          ${hasBoth ? `<div style="margin-top:8px;font-size:0.7rem;color:var(--warn);">⚠ Duplicate keys detected (_teams_${sd} and _teams_${sd}_${sd}). Click "Merge duplicates" to consolidate.</div>` : ''}
        </div>
      </div>`;
  }).join('');
}

// -- Merge duplicate keys for a single event --
async function adminMergeTeams(sortDate) {
  const rawA = attendanceData[`_teams_${sortDate}`];
  const rawB = attendanceData[`_teams_${sortDate}_${sortDate}`];

  let teamsA = null, teamsB = null;
  try { if (rawA) teamsA = JSON.parse(rawA); } catch(e) {}
  try { if (rawB) teamsB = JSON.parse(rawB); } catch(e) {}

  if (!teamsA && !teamsB) { alert('No team data found for this event.'); return; }

  // Union merge -- same logic as getTeamsForEvent but writes back
  const merged = {};
  [...(teamsA || []), ...(teamsB || [])].forEach(t => {
    if (!merged[t.name]) merged[t.name] = { name: t.name, players: [] };
    (t.players || []).forEach(p => {
      if (!merged[t.name].players.includes(p)) merged[t.name].players.push(p);
    });
  });
  const mergedTeams = Object.values(merged).filter(t => t.players.length > 0 || teamsA?.some(x => x.name === t.name));
  const totalPlayers = mergedTeams.reduce((s, t) => s + t.players.length, 0);
  const summary = mergedTeams.map(t => `${t.name} (${t.players.length})`).join(', ');

  if (!confirm(`Merge teams for this event?\n\n${summary}\nTotal: ${totalPlayers} players\n\nThis will consolidate both data records into one.`)) return;

  await saveTeamData(sortDate, mergedTeams);
  await renderSeasonTeamManager(); // refresh the full season view
  renderTeamsSignup();
}

// Registry -- master list of all team names ever used
const HISTORICAL_TEAM_NAMES = [
  'Pile of Shame Support Network',
  '[C]lap or Be Clapped',
  'The Sh[a]meful Suspects',
  'Shame before [B]eauty',
  "[D]a Empuror's Shamepions",
  '[E]verlasting Shame'
];

function getTeamRegistry() {
  const raw = attendanceData['_team_registry_19700101'];
  if (raw) {
    try { return JSON.parse(raw); } catch(e) {}
  }
  return [...HISTORICAL_TEAM_NAMES];
}

async function saveTeamRegistry(names) {
  try {
    await fetch(`${API}/attendance`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        player_name: '_team_registry_19700101',
        event_sort_date: 19700101,
        status: JSON.stringify(names),
        pin: TEAM_PIN
      })
    });
    await loadAttendance();
  } catch(e) {
    console.error('Failed to save team registry', e);
  }
}

function getTeamsForEvent(sortDate) {
  // Read both key formats -- merge if both exist to handle duplicate saves
  const rawA = attendanceData[`_teams_${sortDate}`];
  const rawB = attendanceData[`_teams_${sortDate}_${sortDate}`];

  let teamsA = null, teamsB = null;
  try { if (rawA) teamsA = JSON.parse(rawA); } catch(e) {}
  try { if (rawB) teamsB = JSON.parse(rawB); } catch(e) {}

  // If both keys exist, merge by taking the union of players per team name
  if (teamsA && teamsB) {
    const merged = {};
    [...teamsA, ...teamsB].forEach(t => {
      if (!merged[t.name]) merged[t.name] = { name: t.name, players: [] };
      t.players.forEach(p => {
        if (!merged[t.name].players.includes(p)) merged[t.name].players.push(p);
      });
    });
    return Object.values(merged);
  }

  const teams = teamsA || teamsB;
  if (teams) return teams;

  // No saved state -- return team shells with no players assigned
  return DEFAULT_ITT_TEAMS.map(t => ({ name: t.name, players: [] }));
}

async function renderTeamsSignup() {
  const el = document.getElementById('whos-going-teams-grid');
  if (!el) return;
  el.innerHTML = `<div style="font-size:0.82rem;color:var(--muted);">Loading...</div>`;
  if (!dbEvents || !dbEvents.length) await loadDbEvents();
  await loadAttendance();

  const TODAY = getTodaySortDate();
  const ittEvents = getCalendarEvents().filter(ev => ev.type === 'Teams' && ev.sortDate >= TODAY)
    .sort((a,b) => a.sortDate - b.sortDate).slice(0, 4);

  if (!ittEvents.length) {
    el.innerHTML = `<div style="font-size:0.85rem;color:var(--muted);">No upcoming ITT events found.</div>`;
    return;
  }

  let activeIttIdx = 0;
  const allPlayers = D.players.map(p => p.name).filter(Boolean).sort();

  function renderIttEvent(idx) {
    const ev = ittEvents[idx];
    const teams = getTeamsForEvent(ev.sortDate);
    const registry = getTeamRegistry();

    // Names not yet on this event's active teams
    const activeNames = teams.map(t => t.name);
    const availableFromRegistry = registry.filter(n => !activeNames.includes(n));

    const eventSelector = ittEvents.length > 1 ? `
      <div style="display:flex;gap:6px;margin-bottom:1.25rem;flex-wrap:wrap;">
        ${ittEvents.map((e, i) => `
          <button onclick="renderIttIdx(${i})"
            style="font-size:0.78rem;padding:5px 12px;border-radius:4px;cursor:pointer;font-family:'DM Sans',sans-serif;
                   background:${i===idx?'var(--accent)':'var(--surface2)'};
                   border:1px solid ${i===idx?'var(--accent)':'var(--border)'};
                   color:${i===idx?'#fff':'var(--muted)'};">
            ${e.name} · ${e.dates}
          </button>`).join('')}
      </div>` : `<div style="font-size:0.88rem;color:var(--text);margin-bottom:1.25rem;font-weight:400;">${ev.name} · ${ev.dates}</div>`;

    const teamsHtml = teams.map((team, ti) => {
      const playersInOtherTeams = teams.filter((_,i) => i !== ti).flatMap(t => t.players);
      const available = allPlayers.filter(p => !playersInOtherTeams.includes(p) && !team.players.includes(p));

      return `
        <div style="background:var(--surface);border:1px solid var(--border);border-radius:6px;padding:1rem;margin-bottom:10px;">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;gap:8px;">
            <input id="team-name-${ev.sortDate}-${ti}" value="${team.name.replace(/"/g,'&quot;')}"
              style="flex:1;font-family:'Bebas Neue',sans-serif;font-size:1.1rem;letter-spacing:0.04em;
                     background:transparent;border:none;border-bottom:1px solid var(--border);
                     color:var(--text);padding:2px 4px;outline:none;"
              onchange="updateTeamName(${ev.sortDate},${ti},this.value)"/>
            <button onclick="removeTeam(${ev.sortDate},${ti})"
              style="font-size:0.7rem;padding:3px 8px;background:transparent;border:1px solid var(--loss);
                     border-radius:3px;color:var(--loss);cursor:pointer;flex-shrink:0;">Remove</button>
          </div>
          <div style="display:flex;flex-wrap:wrap;gap:5px;margin-bottom:10px;">
            ${team.players.length ? team.players.map(p => `
              <div style="display:flex;align-items:center;gap:4px;background:var(--surface2);
                          border:1px solid var(--border);border-radius:4px;padding:3px 8px;">
                <span style="font-size:0.78rem;color:var(--text);">${p}</span>
                <button data-sortdate="${ev.sortDate}" data-ti="${ti}" data-player="${p.replace(/"/g,'&quot;')}"
                  onclick="removePlayerFromTeam(parseInt(this.dataset.sortdate),parseInt(this.dataset.ti),this.dataset.player)"
                  style="background:none;border:none;color:var(--muted);cursor:pointer;font-size:0.8rem;line-height:1;padding:0 2px;">✕</button>
              </div>`).join('') : `<span style="font-size:0.75rem;color:var(--faint);">No players yet</span>`}
          </div>
          ${available.length ? `
          <div style="display:flex;align-items:center;gap:6px;">
            <select id="add-player-${ev.sortDate}-${ti}"
              style="flex:1;padding:5px 8px;background:var(--surface2);border:1px solid var(--border);
                     border-radius:4px;color:var(--text);font-family:'DM Sans',sans-serif;font-size:0.82rem;">
              <option value="">Add player...</option>
              ${available.map(p => `<option value="${p}">${p}</option>`).join('')}
            </select>
            <button onclick="addPlayerToTeam(${ev.sortDate},${ti})"
              style="padding:5px 12px;background:var(--accent);border:none;border-radius:4px;
                     color:#fff;font-family:'DM Sans',sans-serif;font-size:0.82rem;cursor:pointer;">Add</button>
          </div>` : `<div style="font-size:0.72rem;color:var(--faint);">All players assigned</div>`}
        </div>`;
    }).join('');

    // Add team controls -- dropdown from registry + new name option
    const addTeamHtml = `
      <div style="margin-top:1rem;padding-top:1rem;border-top:1px solid var(--border);">
        <div style="font-size:0.65rem;font-weight:500;letter-spacing:0.1em;text-transform:uppercase;color:var(--muted);margin-bottom:8px;">Add a team</div>
        <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin-bottom:1rem;">
          <select id="add-team-select-${ev.sortDate}"
            style="flex:1;min-width:180px;padding:7px 10px;background:var(--surface2);border:1px solid var(--border);border-radius:4px;
                   color:var(--text);font-family:'DM Sans',sans-serif;font-size:0.82rem;">
            ${availableFromRegistry.length ? `<option value="">Select from known teams...</option>
            ${availableFromRegistry.map(n => `<option value="${n}">${n}</option>`).join('')}
            <option value="" disabled>----------</option>` : `<option value="">All known teams active -- </option>`}
            <option value="__new__">+ Enter a new team name...</option>
          </select>
          <button onclick="addTeamFromDropdown(${ev.sortDate})"
            style="padding:7px 16px;background:var(--accent);border:none;border-radius:4px;
                   color:#fff;font-family:'DM Sans',sans-serif;font-size:0.82rem;cursor:pointer;white-space:nowrap;"
            onmouseover="this.style.opacity='0.85'" onmouseout="this.style.opacity='1'">
            + Add team
          </button>
          <button onclick="copyTeamsFromLastItt(${ev.sortDate})"
            style="padding:7px 12px;background:transparent;border:1px solid var(--border);border-radius:4px;
                   color:var(--muted);font-family:'DM Sans',sans-serif;font-size:0.82rem;cursor:pointer;white-space:nowrap;"
            onmouseover="this.style.borderColor='var(--faint)';this.style.color='var(--text)'"
            onmouseout="this.style.borderColor='var(--border)';this.style.color='var(--muted)'">
            ↩ Load last ITT roster
          </button>
        </div>
        <!-- Registry viewer -->
        <div>
          <div style="font-size:0.65rem;font-weight:500;letter-spacing:0.1em;text-transform:uppercase;color:var(--muted);margin-bottom:6px;">
            Known team names (${registry.length})
          </div>
          <div style="display:flex;flex-wrap:wrap;gap:4px;">
            ${registry.map(n => `
              <div style="display:flex;align-items:center;gap:3px;background:var(--surface2);border:1px solid ${activeNames.includes(n)?'var(--accent-muted)':'var(--border)'};border-radius:3px;padding:2px 8px;">
                <span style="font-size:0.72rem;color:${activeNames.includes(n)?'var(--accent)':'var(--muted)'};">${n}</span>
                <button onclick="removeFromRegistry('${n.replace(/'/g,"\\'")}')"
                  title="Remove from registry" style="background:none;border:none;color:var(--faint);cursor:pointer;font-size:0.75rem;padding:0 1px;line-height:1;">✕</button>
              </div>`).join('')}
          </div>
          <div style="font-size:0.68rem;color:var(--faint);margin-top:5px;">Orange border = active in this event. ✕ removes permanently.</div>
        </div>
      </div>`;

    el.innerHTML = `
      ${eventSelector}
      <div style="font-size:0.78rem;color:var(--muted);margin-bottom:1rem;">
        Build your ITT teams. Click a team name to rename it. Changes save automatically.
      </div>
      ${teamsHtml}
      ${addTeamHtml}`;

    window._ittState = { sortDate: ev.sortDate, teams, idx };
  }

  window.renderIttIdx = (idx) => { activeIttIdx = idx; renderIttEvent(idx); };
  renderIttEvent(activeIttIdx);

  // -- Mutation helpers --

  window.updateTeamName = async (sortDate, ti, newName) => {
    if (!newName.trim()) return;
    const teams = getTeamsForEvent(sortDate);
    const oldName = teams[ti].name;
    teams[ti].name = newName.trim();
    await saveTeamData(sortDate, teams);
    // Add to registry if new
    const registry = getTeamRegistry();
    if (!registry.includes(newName.trim())) {
      registry.push(newName.trim());
      // Remove old name from registry if it was auto-generated
      if (oldName === 'New Team') {
        const idx = registry.indexOf('New Team');
        if (idx > -1) registry.splice(idx, 1);
      }
      await saveTeamRegistry(registry);
    }
    renderIttEvent(activeIttIdx);
  };

  window.addTeamFromDropdown = async (sortDate) => {
    const sel = document.getElementById(`add-team-select-${sortDate}`);
    let name = sel?.value;
    if (!name) return;
    if (name === '__new__') {
      name = prompt('Enter new team name:')?.trim();
      if (!name) return;
    }
    const teams = getTeamsForEvent(sortDate);
    if (teams.some(t => t.name === name)) return; // already exists
    teams.push({ name, players: [] });
    await saveTeamData(sortDate, teams);
    // Add to registry
    const registry = getTeamRegistry();
    if (!registry.includes(name)) {
      registry.push(name);
      await saveTeamRegistry(registry);
    }
    renderIttEvent(activeIttIdx);
  };

  window.removeTeam = async (sortDate, ti) => {
    if (!confirm('Remove this team from this event?')) return;
    const teams = getTeamsForEvent(sortDate);
    teams.splice(ti, 1);
    await saveTeamData(sortDate, teams);
    // Registry unchanged -- team name stays for future use
    renderIttEvent(activeIttIdx);
  };

  window.removeFromRegistry = async (name) => {
    if (!confirm(`Remove "${name}" from the team registry permanently?`)) return;
    const registry = getTeamRegistry().filter(n => n !== name);
    await saveTeamRegistry(registry);
    renderIttEvent(activeIttIdx);
  };

  window.addPlayerToTeam = async (sortDate, ti) => {
    const sel = document.getElementById(`add-player-${sortDate}-${ti}`);
    const player = sel?.value;
    if (!player) return;
    const teams = getTeamsForEvent(sortDate);
    if (!teams[ti].players.includes(player)) teams[ti].players.push(player);
    await saveTeamData(sortDate, teams);
    renderIttEvent(activeIttIdx);
  };

  window.removePlayerFromTeam = async (sortDate, ti, player) => {
    const teams = getTeamsForEvent(sortDate);
    teams[ti].players = teams[ti].players.filter(p => p !== player);
    await saveTeamData(sortDate, teams);
    renderIttEvent(activeIttIdx);
  };

  window.copyTeamsFromLastItt = async (sortDate) => {
    if (!confirm('Load last ITT roster into these teams? This will overwrite the current setup.')) return;
    await saveTeamData(sortDate, JSON.parse(JSON.stringify(DEFAULT_ITT_TEAMS)));
    renderIttEvent(activeIttIdx);
  };
}

// -- league --
let leagueData = null;
let activePod = 0;
let leagueLoaded = false;

async function renderLeague() {
  if (!leagueLoaded) {
    await loadLeagueData();
    leagueLoaded = true;
  }
  renderPod();
}

async function loadLeagueData() {
  try {
    const res = await fetch(`${API}/league`);
    const ct = res.headers.get('content-type') || '';
    if (!res.ok || !ct.includes('application/json')) {
      document.getElementById('league-content').innerHTML = '<div style="font-size:0.85rem;color:var(--muted);">Could not load league data.</div>';
      return;
    }
    leagueData = await res.json();
    if (leagueData.season) document.getElementById('league-title').textContent = `PSSN League -- ${leagueData.season.name}`;
    buildPodTabBar();
    buildNowPanel(); // refresh now panel with league leaders
    } catch(e) {
    console.warn('League load error:', e);
    document.getElementById('league-content').innerHTML = '<div style="font-size:0.85rem;color:var(--muted);">Could not load league data.</div>';
  }
}

function buildPodTabBar() {
  const bar = document.getElementById('pod-tab-bar');
  bar.innerHTML = '';
  (leagueData.pods || []).forEach((pod, i) => {
    const btn = document.createElement('button');
    btn.className = 'tab-btn' + (i === 0 ? ' active' : '');
    btn.textContent = pod.name;
    btn.onclick = () => switchPod(i);
    btn.id = `pod-btn-${i}`;
    bar.appendChild(btn);
  });
  const playoffBtn = document.createElement('button');
  playoffBtn.className = 'tab-btn';
  playoffBtn.textContent = '🏆 Playoffs';
  playoffBtn.id = 'pod-btn-playoffs';
  playoffBtn.onclick = () => switchPod('playoffs');
  bar.appendChild(playoffBtn);

  // Archive tab if any
  if ((leagueData.archive || []).length) {
    const archBtn = document.createElement('button');
    archBtn.className = 'tab-btn';
    archBtn.textContent = '📋 Archive';
    archBtn.id = 'pod-btn-archive';
    archBtn.onclick = () => switchPod('archive');
    bar.appendChild(archBtn);
  }
}

function switchPod(idx) {
  activePod = idx;
  document.querySelectorAll('#pod-tab-bar .tab-btn').forEach(b => b.classList.remove('active'));
  const btn = document.getElementById(idx === 'playoffs' ? 'pod-btn-playoffs' : idx === 'archive' ? 'pod-btn-archive' : `pod-btn-${idx}`);
  if (btn) btn.classList.add('active');
  renderPod();
}

function renderPod() {
  const el = document.getElementById('league-content');
  if (!el || !leagueData) return;
  if (activePod === 'playoffs') { renderPlayoffs(el); return; }
  if (activePod === 'archive') { renderArchive(el); return; }

  const pod = leagueData.pods?.[activePod];
  if (!pod) return;

  // Use shared standings calculator
  const { sorted, standings, podGames, podPlayers } = calcPodStandings(
    pod.id, leagueData.players || [], leagueData.games || []
  );

  // Detect tiebreakers -- players equal on both pts AND bp in qualification positions
  const tieWarnings = [];
  // Check positions 1-2 (qualification spots) and position 2-3 (bubble)
  for (let i = 0; i < sorted.length - 1; i++) {
    const a = sorted[i], b = sorted[i+1];
    if (a.pts === b.pts && a.bp === b.bp) {
      const isQualBoundary = i === 1; // tied on the qualification cut line
      tieWarnings.push({ names: [a.name, b.name], pos: i+1, isQualBoundary });
    }
  }

  // Build matrix
  const matrix = {};
  podPlayers.forEach(p => { matrix[p] = {}; });
  podGames.forEach(g => {
    if (!matrix[g.player1]) matrix[g.player1] = {};
    if (!matrix[g.player2]) matrix[g.player2] = {};
    matrix[g.player1][g.player2] = g.bp1;
    matrix[g.player2][g.player1] = g.bp2;
  });

  const names = podPlayers;
  let html = `
    <div style="margin-bottom:2rem;">
      <div style="font-size:0.7rem;font-weight:500;letter-spacing:0.1em;text-transform:uppercase;color:var(--muted);margin-bottom:10px;">${pod.name} Standings</div>
      <table class="event-table league-table" style="width:100%;max-width:560px;">
        <thead><tr>
          <th style="padding-left:1rem;">Pos</th><th>Player</th>
          <th style="text-align:center;">Played</th><th style="text-align:center;">Points</th>
          <th style="text-align:right;padding-right:1rem;">Battle Pts</th>
        </tr></thead>
        <tbody>
          ${sorted.map((p,i) => {
            const q = i < 2;
            const badge = q ? `<span style="font-size:0.6rem;padding:1px 5px;border-radius:3px;background:var(--accent-bg);color:var(--accent);margin-left:6px;">${i===0?'WINNER':'RUNNER-UP'}</span>` : '';
            return `<tr>
              <td style="padding-left:1rem;font-family:'Bebas Neue',sans-serif;font-size:1rem;color:${q?'var(--accent)':'var(--muted)'};">${i+1}</td>
              <td style="font-size:0.88rem;color:var(--text);">${p.name}${badge}</td>
              <td style="text-align:center;font-size:0.85rem;color:var(--muted);">${p.played}</td>
              <td style="text-align:center;"><span style="font-family:'Bebas Neue',sans-serif;font-size:1.2rem;color:${p.pts>0?'var(--win)':'var(--muted)'};">${p.pts}</span></td>
              <td style="text-align:right;padding-right:1rem;font-size:0.85rem;color:var(--muted);">${p.bp}</td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>
    </div>
    ${tieWarnings.length ? `
      <div style="margin-top:10px;padding:8px 12px;background:#2a1500;border:1px solid #f0c040;border-radius:4px;font-size:0.78rem;color:#f0c040;">
        ${tieWarnings.map(t => `⚠️ <strong>${t.names[0]}</strong> and <strong>${t.names[1]}</strong> are exactly tied on points and Battle Points at position ${t.pos}-${t.pos+1}.${t.isQualBoundary ? ' This is the <strong>qualification boundary</strong> -- a tiebreaker or manual decision is needed before the playoffs.' : ''}`).join('<br>')}
      </div>` : ''}
    <div>
      <div style="font-size:0.7rem;font-weight:500;letter-spacing:0.1em;text-transform:uppercase;color:var(--muted);margin-bottom:10px;">Games Matrix -- Battle Points scored</div>
      <div style="overflow-x:auto;-webkit-overflow-scrolling:touch;">
        <table class="event-table league-table" style="min-width:${Math.max(400, names.length * 70)}px;width:100%;">
          <thead><tr>
            <th style="padding-left:1rem;">vs</th>
            ${names.map(n=>`<th style="text-align:center;font-size:0.65rem;min-width:50px;">${n.split(' ')[0]}</th>`).join('')}
          </tr></thead>
          <tbody>
            ${names.map(row=>`
              <tr>
                <td style="padding-left:1rem;font-size:0.82rem;color:var(--text);white-space:nowrap;">${row}</td>
                ${names.map(col=>{
                  if(row===col) return `<td style="text-align:center;background:var(--surface2);"></td>`;
                  const score = matrix[row]?.[col];
                  if(score===undefined) return `<td style="text-align:center;color:var(--faint);">--</td>`;
                  const won = score > (matrix[col]?.[row]??0);
                  return `<td style="text-align:center;font-size:0.85rem;color:${won?'var(--win)':'var(--loss)'};font-weight:${won?'500':'300'};">${score}</td>`;
                }).join('')}
              </tr>`).join('')}
          </tbody>
        </table>
      </div>
      <div style="font-size:0.72rem;color:var(--muted);margin-top:8px;">
        <span style="color:var(--win);">Green</span> = won &nbsp;·&nbsp; <span style="color:var(--loss);">Red</span> = lost &nbsp;·&nbsp; -- = not yet played
      </div>
    </div>`;
  el.innerHTML = html;
}

function renderPlayoffs(el) {
  const bracket = leagueData.bracket || {};
  const seedings = leagueData.seedings || {};
  const season_id = leagueData.season?.id;

  const playerBox = (slot, label, isBye) => {
    if (!slot) return `<div style="font-size:0.78rem;color:var(--faint);padding:4px 0;">TBD</div>`;
    const name = slot.name || 'TBD';
    const bp = slot.bp ? ` · ${slot.bp}bp` : '';
    const pod = slot.pod ? ` <span style="font-size:0.65rem;color:var(--muted);">(${slot.pod})</span>` : '';
    const byeBadge = isBye ? `<span style="font-size:0.6rem;padding:1px 4px;background:var(--accent-bg);color:var(--accent);border-radius:3px;margin-left:4px;">BYE</span>` : '';
    return `<div style="font-size:0.82rem;color:var(--text);">${name}${pod}${byeBadge}<span style="font-size:0.7rem;color:var(--muted);">${bp}</span></div>`;
  };

  const matchCard = (key, round, num, byeSlots, label) => {
    const m = bracket[key] || {};
    const hasResult = m.winner;
    const pending = (leagueData.pendingPlayoffs || []).find(p => p.round === round && p.match_number === num);
    const isBye1 = byeSlots && byeSlots[0];
    const isBye2 = byeSlots && byeSlots[1];

    let scoreHtml = '';
    if (hasResult) {
      scoreHtml = `<div style="font-size:0.7rem;color:var(--muted);margin-top:6px;padding-top:6px;border-top:1px solid var(--border);">
        <span style="color:var(--win);font-weight:500;">${m.winner}</span> won · ${m.bp1}-${m.bp2}
      </div>`;
    } else if (pending) {
      scoreHtml = `<div style="font-size:0.7rem;color:#f0c040;margin-top:6px;">⏳ Pending approval</div>`;
    }

    const canSubmit = m.p1 && m.p2 && !hasResult && !pending;
    const submitBtn = canSubmit ? `<button onclick="openPlayoffSubmit('${key}','${round}',${num},'${(m.p1?.name||'').replace(/'/g,"\\'")}','${(m.p2?.name||'').replace(/'/g,"\\'")}',${season_id})"
      style="margin-top:8px;font-size:0.7rem;padding:3px 8px;background:transparent;border:1px solid var(--border);border-radius:3px;color:var(--muted);cursor:pointer;width:100%;"
      onmouseover="this.style.borderColor='var(--accent)';this.style.color='var(--accent)'"
      onmouseout="this.style.borderColor='var(--border)';this.style.color='var(--muted)'">+ Submit result</button>` : '';

    return `<div style="background:${hasResult?'var(--surface2)':'var(--surface)'};border:1px solid ${hasResult?'var(--border)':'var(--border)'};border-radius:4px;padding:8px 10px;margin-bottom:6px;">
      <div style="font-size:0.6rem;color:var(--muted);margin-bottom:4px;letter-spacing:0.08em;">${label}</div>
      <div style="border-bottom:1px solid var(--border);padding-bottom:4px;margin-bottom:4px;">${playerBox(m.p1, 'p1', isBye1)}</div>
      ${playerBox(m.p2, 'p2', isBye2)}
      ${scoreHtml}
      ${submitBtn}
    </div>`;
  };

  el.innerHTML = `
    <div style="font-size:0.82rem;color:var(--muted);margin-bottom:1.5rem;">
      Seeded by battle points. Pod winners 1-4 receive byes to the Semi Finals. Pod winners 5-6 enter at Quarter Finals alongside all 6 runners-up.
    </div>

    <!-- Seedings summary -->
    <div style="display:flex;gap:1rem;flex-wrap:wrap;margin-bottom:2rem;">
      <div style="flex:1;min-width:220px;background:var(--surface);border:1px solid var(--border);border-radius:6px;padding:1rem;">
        <div style="font-size:0.65rem;font-weight:500;letter-spacing:0.1em;text-transform:uppercase;color:var(--accent);margin-bottom:8px;">Pod Winners</div>
        ${(seedings.byeWinners||[]).concat(seedings.qfWinners||[]).map((w,i) => `
          <div style="display:flex;justify-content:space-between;align-items:center;padding:3px 0;border-bottom:1px solid var(--border);font-size:0.8rem;">
            <span style="color:${i<4?'var(--text)':'var(--muted)'};">${i+1}. ${w.name}</span>
            <span style="font-size:0.7rem;color:var(--muted);">${w.bp}bp ${i<4?'<span style="color:var(--accent);">BYE</span>':'→ QF'}</span>
          </div>`).join('')}
      </div>
      <div style="flex:1;min-width:220px;background:var(--surface);border:1px solid var(--border);border-radius:6px;padding:1rem;">
        <div style="font-size:0.65rem;font-weight:500;letter-spacing:0.1em;text-transform:uppercase;color:var(--muted);margin-bottom:8px;">Runners-Up</div>
        ${(seedings.runnersUp||[]).map((r,i) => `
          <div style="display:flex;justify-content:space-between;align-items:center;padding:3px 0;border-bottom:1px solid var(--border);font-size:0.8rem;">
            <span style="color:var(--text);">${i+1}. ${r.name}</span>
            <span style="font-size:0.7rem;color:var(--muted);">${r.bp}bp → QF${[1,2,2,3,3,1][i]||''}</span>
          </div>`).join('')}
      </div>
    </div>

    <!-- Bracket -->
    <div style="overflow-x:auto;">
      <div style="display:grid;grid-template-columns:repeat(4,minmax(160px,1fr));gap:1rem;width:100%;">

        <div>
          <div style="font-size:0.65rem;font-weight:500;letter-spacing:0.1em;text-transform:uppercase;color:var(--muted);text-align:center;margin-bottom:10px;padding-bottom:6px;border-bottom:1px solid var(--border);">Quarter Finals</div>
          ${matchCard('QF1','QF',1,null,'QF 1 · 1st vs 6th Runner-up')}
          ${matchCard('QF2','QF',2,null,'QF 2 · 2nd vs 5th Runner-up')}
          ${matchCard('QF3','QF',3,null,'QF 3 · 3rd vs 4th Runner-up')}
          ${matchCard('QF4','QF',4,null,'QF 4 · 5th vs 6th Pod Winner')}
        </div>

        <div>
          <div style="font-size:0.65rem;font-weight:500;letter-spacing:0.1em;text-transform:uppercase;color:var(--muted);text-align:center;margin-bottom:10px;padding-bottom:6px;border-bottom:1px solid var(--border);">Semi Finals</div>
          ${matchCard('SF1','SF',1,[true,false],'SF 1 · 1st Winner (bye) vs QF1')}
          ${matchCard('SF2','SF',2,[true,false],'SF 2 · 2nd Winner (bye) vs QF2')}
          ${matchCard('SF3','SF',3,[true,false],'SF 3 · 3rd Winner (bye) vs QF3')}
          ${matchCard('SF4','SF',4,[true,false],'SF 4 · 4th Winner (bye) vs QF4')}
        </div>

        <div>
          <div style="font-size:0.65rem;font-weight:500;letter-spacing:0.1em;text-transform:uppercase;color:var(--muted);text-align:center;margin-bottom:10px;padding-bottom:6px;border-bottom:1px solid var(--border);">Finals</div>
          ${matchCard('F1','F',1,null,'Final 1 · SF1 vs SF2')}
          ${matchCard('F2','F',2,null,'Final 2 · SF3 vs SF4')}
        </div>

        <div>
          <div style="font-size:0.65rem;font-weight:500;letter-spacing:0.1em;text-transform:uppercase;color:var(--accent);text-align:center;margin-bottom:10px;padding-bottom:6px;border-bottom:1px solid var(--accent-muted);">🏆 Grand Final</div>
          <div style="background:var(--accent-bg);border:2px solid var(--accent-muted);border-radius:6px;padding:1rem;text-align:center;">
            ${matchCard('GF','GF',1,null,'Grand Final')}
            ${bracket.GF?.winner ? `<div style="font-size:1.1rem;font-family:'Bebas Neue',sans-serif;color:var(--accent);margin-top:8px;">🏆 ${bracket.GF.winner}</div>` : ''}
          </div>
        </div>

      </div>
    </div>

    <!-- Playoff result submission modal -->
    <div id="playoff-modal" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,0.7);z-index:1000;align-items:center;justify-content:center;">
      <div style="background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:1.5rem;max-width:400px;width:90%;margin:auto;">
        <div style="font-family:'Bebas Neue',sans-serif;font-size:1.3rem;letter-spacing:0.06em;color:var(--text);margin-bottom:4px;" id="pm-title">Submit Result</div>
        <div style="font-size:0.78rem;color:var(--muted);margin-bottom:1rem;" id="pm-subtitle"></div>
        <div style="display:grid;gap:10px;">
          <div id="pm-pin-wrap">
            <label style="font-size:0.72rem;color:var(--muted);text-transform:uppercase;letter-spacing:0.06em;display:block;margin-bottom:4px;">Team PIN</label>
            <input id="pm-pin" type="password" maxlength="4" placeholder="••••"
              style="width:100%;padding:8px;background:var(--surface2);border:1px solid var(--border);border-radius:4px;color:var(--text);font-family:'DM Sans',sans-serif;font-size:1rem;text-align:center;letter-spacing:0.2em;outline:none;"/>
          </div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">
            <div>
              <label id="pm-p1-label" style="font-size:0.72rem;color:var(--muted);text-transform:uppercase;letter-spacing:0.06em;display:block;margin-bottom:4px;"></label>
              <input id="pm-bp1" type="number" min="0" max="100" placeholder="BP"
                style="width:100%;padding:8px;background:var(--surface2);border:1px solid var(--border);border-radius:4px;color:var(--text);font-family:'DM Sans',sans-serif;font-size:1rem;text-align:center;"/>
            </div>
            <div>
              <label id="pm-p2-label" style="font-size:0.72rem;color:var(--muted);text-transform:uppercase;letter-spacing:0.06em;display:block;margin-bottom:4px;"></label>
              <input id="pm-bp2" type="number" min="0" max="100" placeholder="BP"
                style="width:100%;padding:8px;background:var(--surface2);border:1px solid var(--border);border-radius:4px;color:var(--text);font-family:'DM Sans',sans-serif;font-size:1rem;text-align:center;"/>
            </div>
          </div>
          <button onclick="submitPlayoffResult()"
            style="width:100%;padding:10px;background:var(--accent);border:none;border-radius:4px;color:#fff;font-family:'DM Sans',sans-serif;font-size:0.9rem;font-weight:500;cursor:pointer;">
            Submit Result
          </button>
          <button onclick="document.getElementById('playoff-modal').style.display='none'"
            style="width:100%;padding:8px;background:transparent;border:1px solid var(--border);border-radius:4px;color:var(--muted);font-family:'DM Sans',sans-serif;font-size:0.85rem;cursor:pointer;">
            Cancel
          </button>
          <div id="pm-message" style="font-size:0.8rem;display:none;"></div>
        </div>
      </div>
    </div>`;
}

let _pmData = {};
function openPlayoffSubmit(key, round, num, p1, p2, seasonId) {
  _pmData = { key, round, num, p1, p2, seasonId };
  document.getElementById('pm-title').textContent = `Submit ${round}${num} Result`;
  document.getElementById('pm-subtitle').textContent = `${p1} vs ${p2}`;
  document.getElementById('pm-p1-label').textContent = p1;
  document.getElementById('pm-p2-label').textContent = p2;
  document.getElementById('pm-bp1').value = '';
  document.getElementById('pm-bp2').value = '';
  document.getElementById('pm-message').style.display = 'none';
  // Pre-fill PIN if already unlocked this session, otherwise show PIN field
  const sessionPin = sessionStorage.getItem('pssn_team_unlocked') === '1' ? TEAM_PIN : '';
  const pinEl = document.getElementById('pm-pin');
  const pinWrap = document.getElementById('pm-pin-wrap');
  if (pinEl) {
    pinEl.value = sessionPin;
    // Hide PIN field if already authenticated this session
    if (pinWrap) pinWrap.style.display = sessionPin ? 'none' : 'block';
  }
  document.getElementById('playoff-modal').style.display = 'flex';
}

async function submitPlayoffResult() {
  const msg = document.getElementById('pm-message');
  const bp1 = parseInt(document.getElementById('pm-bp1').value);
  const bp2 = parseInt(document.getElementById('pm-bp2').value);
  const { round, num, p1, p2, seasonId } = _pmData;
  // Get PIN from modal field, falling back to session if field is hidden
  const pinInput = document.getElementById('pm-pin')?.value?.trim();
  const pinToUse = pinInput || (sessionStorage.getItem('pssn_team_unlocked') === '1' ? TEAM_PIN : '');
  if (!pinToUse) {
    msg.style.display = 'block'; msg.style.color = 'var(--loss)';
    msg.textContent = 'Please enter the team PIN.'; return;
  }

  if (isNaN(bp1) || isNaN(bp2)) {
    msg.style.display = 'block'; msg.style.color = 'var(--loss)';
    msg.textContent = 'Please enter both scores.'; return;
  }
  if (bp1 < 0 || bp1 > 100 || bp2 < 0 || bp2 > 100) {
    msg.style.display = 'block'; msg.style.color = 'var(--loss)';
    msg.textContent = 'Battle Points must be between 0 and 100.'; return;
  }
  if (bp1 === bp2) {
    msg.style.display = 'block'; msg.style.color = 'var(--loss)';
    msg.textContent = 'Playoff matches cannot be draws.'; return;
  }

  msg.style.display = 'block'; msg.style.color = 'var(--muted)';
  msg.textContent = 'Submitting...';

  try {
    const res = await fetch(`${API}/league`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        pin: pinToUse,
        type: 'playoff',
        season_id: seasonId,
        round, match_number: num,
        player1: p1, player2: p2,
        bp1, bp2,
        winner: bp1 > bp2 ? p1 : p2
      })
    });
    const data = await res.json();
    if (data.success) {
      msg.style.color = data.approved ? 'var(--win)' : '#f0c040';
      msg.textContent = data.approved ? '✓ Result saved!' : '⏳ Submitted -- pending admin approval.';
      leagueLoaded = false;
      setTimeout(async () => {
        document.getElementById('playoff-modal').style.display = 'none';
        await loadLeagueData();
        renderPod();
      }, 1500);
    } else {
      msg.style.color = 'var(--loss)';
      msg.textContent = 'Error: ' + (data.error || 'Unknown');
    }
  } catch(e) {
    msg.style.color = 'var(--loss)';
    msg.textContent = 'Network error.';
  }
}

function renderArchive(el) {
  const archive = leagueData.archive || [];
  if (!archive.length) { el.innerHTML = '<div style="font-size:0.85rem;color:var(--muted);">No archived seasons yet.</div>'; return; }

  el.innerHTML = archive.map(a => {
    const d = a.data || {};
    const pods = d.pods || [];
    const playoffs = d.playoffs || [];

    const playoffHtml = playoffs.length ? `
      <div style="margin-top:1.5rem;">
        <div style="font-size:0.7rem;font-weight:500;letter-spacing:0.1em;text-transform:uppercase;color:var(--accent);margin-bottom:8px;">Playoff Results</div>
        <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:8px;">
          ${['QF','SF','F','GF'].map(round => {
            const roundGames = playoffs.filter(p => p.round === round);
            if (!roundGames.length) return '';
            const labels = { QF:'Quarter Finals', SF:'Semi Finals', F:'Finals', GF:'Grand Final' };
            return `<div style="background:var(--surface);border:1px solid var(--border);border-radius:4px;padding:8px;">
              <div style="font-size:0.65rem;font-weight:500;color:var(--accent);margin-bottom:6px;">${labels[round]}</div>
              ${roundGames.map(g => `
                <div style="font-size:0.78rem;padding:3px 0;border-bottom:1px solid var(--border);">
                  <span style="color:var(--win);font-weight:500;">${g.winner}</span>
                  <span style="color:var(--muted);font-size:0.7rem;"> ${g.bp1}-${g.bp2}</span>
                </div>`).join('')}
            </div>`;
          }).join('')}
        </div>
      </div>` : '';

    return `
      <div style="margin-bottom:2rem;">
        <div style="font-family:'Bebas Neue',sans-serif;font-size:1.3rem;letter-spacing:0.06em;color:var(--text);margin-bottom:4px;">${a.label}</div>
        <div style="font-size:0.72rem;color:var(--muted);margin-bottom:1rem;">Archived ${new Date(a.created_at).toLocaleDateString('en-GB',{month:'short',year:'numeric'})}</div>
        <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:1rem;">
          ${pods.map(pod => `
            <div style="background:var(--surface);border:1px solid var(--border);border-radius:6px;padding:1rem;">
              <div style="font-size:0.7rem;font-weight:500;letter-spacing:0.1em;text-transform:uppercase;color:var(--muted);margin-bottom:8px;">${pod.pod}</div>
              ${(pod.standings||[]).map((p,i) => `
                <div style="display:flex;justify-content:space-between;align-items:center;padding:3px 0;border-bottom:1px solid var(--border);font-size:0.8rem;">
                  <span style="color:${i<2?'var(--accent)':'var(--text)'};">${i+1}. ${p.name}</span>
                  <span style="font-size:0.7rem;color:var(--muted);">${p.pts}pts · ${p.bp}bp</span>
                </div>`).join('')}
            </div>`).join('')}
        </div>
        ${playoffHtml}
      </div>`;
  }).join('<hr style="border:none;border-top:1px solid var(--border);margin:2rem 0;">');
}

// -- admin league tools --
function buildLeagueAdmin() {
  const container = document.getElementById('league-admin-section');
  if (!container) return;
  if (!leagueData) {
    container.innerHTML = '<div style="font-size:0.82rem;color:var(--muted);padding:1rem 0;">Loading league data...</div>';
    return;
  }
  const pending = leagueData.pending || [];
  const pendingPlayoffs = leagueData.pendingPlayoffs || [];
  const pods = leagueData.pods || [];
  const season_id = leagueData.season?.id;

  let html = `
    <!-- Add league game -->
    <div class="section-head" style="margin-top:2.5rem;">
      <div class="section-title">League -- Add Game Result</div>
      <div class="section-rule"></div>
    </div>
    <div style="font-size:0.82rem;color:var(--muted);margin-bottom:1rem;">Add a completed pod game. Goes live immediately as admin.</div>
    <div style="background:var(--surface);border:1px solid var(--border);border-radius:6px;padding:1.25rem;max-width:500px;margin-bottom:1.5rem;">
      <div style="display:grid;gap:10px;">
        <div>
          <label style="font-size:0.72rem;color:var(--muted);text-transform:uppercase;letter-spacing:0.06em;display:block;margin-bottom:4px;">Pod</label>
          <select id="lg-pod" onchange="updateLeaguePlayerDropdowns()"
            style="width:100%;padding:7px 10px;background:var(--surface2);border:1px solid var(--border);border-radius:4px;color:var(--text);font-family:'DM Sans',sans-serif;font-size:0.85rem;">
            <option value="">Select pod...</option>
            ${pods.map(p=>`<option value="${p.id}">${p.name}</option>`).join('')}
          </select>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">
          <div>
            <label style="font-size:0.72rem;color:var(--muted);text-transform:uppercase;letter-spacing:0.06em;display:block;margin-bottom:4px;">Player 1</label>
            <select id="lg-p1" onchange="checkLeagueDuplicate()" style="width:100%;padding:7px 10px;background:var(--surface2);border:1px solid var(--border);border-radius:4px;color:var(--text);font-family:'DM Sans',sans-serif;font-size:0.85rem;">
              <option value="">Select pod first</option>
            </select>
          </div>
          <div>
            <label style="font-size:0.72rem;color:var(--muted);text-transform:uppercase;letter-spacing:0.06em;display:block;margin-bottom:4px;">Player 2</label>
            <select id="lg-p2" onchange="checkLeagueDuplicate()" style="width:100%;padding:7px 10px;background:var(--surface2);border:1px solid var(--border);border-radius:4px;color:var(--text);font-family:'DM Sans',sans-serif;font-size:0.85rem;">
              <option value="">Select pod first</option>
            </select>
          </div>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">
          <div>
            <label style="font-size:0.72rem;color:var(--win);text-transform:uppercase;letter-spacing:0.06em;display:block;margin-bottom:4px;">Player 1 BP</label>
            <input id="lg-bp1" type="number" min="0" max="100" placeholder="e.g. 82"
              style="width:100%;padding:7px 10px;background:var(--surface2);border:1px solid var(--border);border-radius:4px;color:var(--text);font-family:'DM Sans',sans-serif;font-size:0.85rem;"/>
          </div>
          <div>
            <label style="font-size:0.72rem;color:var(--win);text-transform:uppercase;letter-spacing:0.06em;display:block;margin-bottom:4px;">Player 2 BP</label>
            <input id="lg-bp2" type="number" min="0" max="100" placeholder="e.g. 74"
              style="width:100%;padding:7px 10px;background:var(--surface2);border:1px solid var(--border);border-radius:4px;color:var(--text);font-family:'DM Sans',sans-serif;font-size:0.85rem;"/>
          </div>
        </div>
        <button id="lg-save-btn" onclick="submitLeagueGame()"
          style="width:100%;padding:9px;background:var(--accent);border:none;border-radius:4px;color:#fff;font-family:'DM Sans',sans-serif;font-size:0.88rem;font-weight:500;cursor:pointer;">
          Save League Game
        </button>
        <div id="lg-message" style="font-size:0.82rem;display:none;"></div>
      </div>
    </div>`;

  // Pending pod games
  if (pending.length) {
    html += `
      <div class="section-head" style="margin-top:1.5rem;">
        <div class="section-title">Pending Pod Results</div>
        <div class="section-rule"></div>
      </div>
      ${pending.map(g=>`
        <div style="background:var(--surface);border:1px solid var(--border);border-radius:4px;padding:10px 14px;margin-bottom:8px;display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;">
          <div>
            <div style="font-size:0.88rem;color:var(--text);">${g.player1} vs ${g.player2}</div>
            <div style="font-size:0.72rem;color:var(--muted);margin-top:2px;">BP: ${g.bp1}-${g.bp2}</div>
          </div>
          <div style="display:flex;gap:6px;">
            <button onclick="approveLeagueGame(${g.id},true)" style="font-size:0.72rem;padding:4px 10px;background:var(--win-bg);border:1px solid var(--win);border-radius:3px;color:var(--win);cursor:pointer;">✓ Approve</button>
            <button onclick="approveLeagueGame(${g.id},false)" style="font-size:0.72rem;padding:4px 10px;background:var(--loss-bg);border:1px solid var(--loss);border-radius:3px;color:var(--loss);cursor:pointer;">✗ Reject</button>
          </div>
        </div>`).join('')}`;
  }

  // Pending playoff results
  if (pendingPlayoffs.length) {
    html += `
      <div class="section-head" style="margin-top:1.5rem;">
        <div class="section-title">Pending Playoff Results</div>
        <div class="section-rule"></div>
      </div>
      ${pendingPlayoffs.map(g=>`
        <div style="background:var(--surface);border:1px solid var(--border);border-radius:4px;padding:10px 14px;margin-bottom:8px;display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;">
          <div>
            <div style="font-size:0.72rem;color:var(--accent);margin-bottom:2px;">${g.round}${g.match_number}</div>
            <div style="font-size:0.88rem;color:var(--text);">${g.player1} vs ${g.player2}</div>
            <div style="font-size:0.72rem;color:var(--muted);margin-top:2px;">BP: ${g.bp1}-${g.bp2} · Winner: <strong>${g.winner}</strong></div>
          </div>
          <div style="display:flex;gap:6px;">
            <button onclick="approvePlayoffGame(${g.id},true)" style="font-size:0.72rem;padding:4px 10px;background:var(--win-bg);border:1px solid var(--win);border-radius:3px;color:var(--win);cursor:pointer;">✓ Approve</button>
            <button onclick="approvePlayoffGame(${g.id},false)" style="font-size:0.72rem;padding:4px 10px;background:var(--loss-bg);border:1px solid var(--loss);border-radius:3px;color:var(--loss);cursor:pointer;">✗ Reject</button>
          </div>
        </div>`).join('')}`;
  }

  // Approved games -- per pod, with edit buttons
  const games = leagueData.games || [];
  if (games.length) {
    const podMap = {};
    games.forEach(g => {
      if (!podMap[g.pod_id]) podMap[g.pod_id] = [];
      podMap[g.pod_id].push(g);
    });
    html += `
      <div class="section-head" style="margin-top:2.5rem;">
        <div class="section-title">Approved Games</div>
        <div class="section-rule"></div>
      </div>
      <div style="font-size:0.8rem;color:var(--muted);margin-bottom:1rem;">All recorded league games. Click Edit to correct Battle Points if something was entered incorrectly.</div>`;

    (leagueData.pods || []).forEach(pod => {
      const podGames = podMap[pod.id] || [];
      if (!podGames.length) return;
      html += `
        <div style="margin-bottom:1.5rem;">
          <div style="font-size:0.7rem;font-weight:500;letter-spacing:0.1em;text-transform:uppercase;color:var(--muted);margin-bottom:6px;">${pod.name}</div>
          ${podGames.map(g => `
            <div id="game-row-${g.id}" style="background:var(--surface);border:1px solid var(--border);border-radius:4px;padding:8px 12px;margin-bottom:6px;">
              <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;">
                <div>
                  <div style="font-size:0.85rem;color:var(--text);">${g.player1} vs ${g.player2}</div>
                  <div id="game-score-${g.id}" style="font-size:0.72rem;color:var(--muted);margin-top:2px;">${g.bp1}-${g.bp2}</div>
                </div>
                <button onclick="openEditGame(${g.id},'${g.player1.replace(/'/g,"\\'")}','${g.player2.replace(/'/g,"\\'")}',${g.bp1},${g.bp2})"
                  style="font-size:0.7rem;padding:3px 10px;background:transparent;border:1px solid var(--border);border-radius:3px;color:var(--muted);cursor:pointer;"
                  onmouseover="this.style.borderColor='var(--accent)';this.style.color='var(--accent)'"
                  onmouseout="this.style.borderColor='var(--border)';this.style.color='var(--muted)'">
                  ✎ Edit
                </button>
              </div>
              <div id="game-edit-${g.id}" style="display:none;margin-top:10px;padding-top:10px;border-top:1px solid var(--border);">
                <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:8px;">
                  <div>
                    <label style="font-size:0.65rem;color:var(--win);text-transform:uppercase;letter-spacing:0.06em;display:block;margin-bottom:3px;">${g.player1} BP</label>
                    <input id="edit-bp1-${g.id}" type="number" min="0" max="100" value="${g.bp1}"
                      style="width:100%;padding:6px 8px;background:var(--surface2);border:1px solid var(--border);border-radius:4px;color:var(--text);font-family:'DM Sans',sans-serif;font-size:0.85rem;"/>
                  </div>
                  <div>
                    <label style="font-size:0.65rem;color:var(--loss);text-transform:uppercase;letter-spacing:0.06em;display:block;margin-bottom:3px;">${g.player2} BP</label>
                    <input id="edit-bp2-${g.id}" type="number" min="0" max="100" value="${g.bp2}"
                      style="width:100%;padding:6px 8px;background:var(--surface2);border:1px solid var(--border);border-radius:4px;color:var(--text);font-family:'DM Sans',sans-serif;font-size:0.85rem;"/>
                  </div>
                </div>
                <div style="display:flex;gap:6px;">
                  <button onclick="saveEditGame(${g.id})"
                    style="padding:5px 14px;background:var(--accent);border:none;border-radius:3px;color:#fff;font-family:'DM Sans',sans-serif;font-size:0.78rem;cursor:pointer;">
                    Save
                  </button>
                  <button onclick="closeEditGame(${g.id})"
                    style="padding:5px 10px;background:transparent;border:1px solid var(--border);border-radius:3px;color:var(--muted);font-family:'DM Sans',sans-serif;font-size:0.78rem;cursor:pointer;">
                    Cancel
                  </button>
                  <div id="edit-msg-${g.id}" style="font-size:0.75rem;color:var(--muted);align-self:center;display:none;"></div>
                </div>
              </div>
            </div>`).join('')}
        </div>`;
    });
  }

  // New season creator
  html += `
    <div class="section-head" style="margin-top:2.5rem;">
      <div class="section-title">New Season Setup</div>
      <div class="section-rule"></div>
    </div>
    <div style="font-size:0.82rem;color:var(--muted);margin-bottom:1rem;">
      Select players for the new season. Pods will be auto-generated with seeded random assignment -- top performers from the current season are spread across pods. <strong style="color:var(--loss);">Archive the current season first before creating a new one.</strong>
    </div>
    <div style="background:var(--surface);border:1px solid var(--border);border-radius:6px;padding:1.5rem;max-width:600px;">
      <div style="display:grid;gap:12px;">
        <div>
          <label style="font-size:0.72rem;color:var(--muted);text-transform:uppercase;letter-spacing:0.06em;display:block;margin-bottom:4px;">Season name</label>
          <input id="ns-name" type="text" placeholder="e.g. Season 2"
            style="width:100%;padding:8px 10px;background:var(--surface2);border:1px solid var(--border);border-radius:4px;color:var(--text);font-family:'DM Sans',sans-serif;font-size:0.85rem;"/>
        </div>
        <div>
          <label style="font-size:0.72rem;color:var(--muted);text-transform:uppercase;letter-spacing:0.06em;display:block;margin-bottom:4px;">Number of pods</label>
          <select id="ns-num-pods"
            style="width:100%;padding:8px 10px;background:var(--surface2);border:1px solid var(--border);border-radius:4px;color:var(--text);font-family:'DM Sans',sans-serif;font-size:0.85rem;">
            ${[4,5,6,7,8].map(n=>`<option value="${n}"${n===6?' selected':''}>${n} pods</option>`).join('')}
          </select>
        </div>
        <div>
          <label style="font-size:0.72rem;color:var(--muted);text-transform:uppercase;letter-spacing:0.06em;display:block;margin-bottom:4px;">Select players <span style="color:var(--faint);font-weight:normal;text-transform:none;">(${(leagueData.allPlayers||[]).filter(p=>p.active).length} active)</span></label>
          <div style="font-size:0.72rem;color:var(--muted);margin-bottom:6px;">Seeded by Season 1 BP total. 🆕 = no Season 1 history, seeds last and distributes evenly. To add someone not listed, use <strong style="color:var(--text);">Admin → Members</strong> first.</div>
          <div id="ns-player-list" style="display:grid;grid-template-columns:1fr 1fr;gap:4px;max-height:300px;overflow-y:auto;padding:8px;background:var(--surface2);border:1px solid var(--border);border-radius:4px;">
            ${(leagueData.allPlayers||[]).filter(p=>p.active).sort((a,b)=>a.name.localeCompare(b.name)).map(p=>`
              <label style="display:flex;align-items:center;gap:6px;font-size:0.82rem;color:var(--text);padding:3px;cursor:pointer;">
                <input type="checkbox" value="${p.name}" checked style="accent-color:var(--accent);"/>
                ${p.name}
              </label>`).join('')}
          </div>
        </div>
        <button onclick="generateSeededPods()"
          style="width:100%;padding:9px;background:var(--surface2);border:1px solid var(--border);border-radius:4px;color:var(--text);font-family:'DM Sans',sans-serif;font-size:0.85rem;cursor:pointer;"
          onmouseover="this.style.borderColor='var(--accent)'" onmouseout="this.style.borderColor='var(--border)'">
          🎲 Generate Seeded Pods
        </button>
        <div id="ns-pods-preview" style="display:none;"></div>
        <button id="ns-create-btn" onclick="createNewSeason()" style="display:none;width:100%;padding:10px;background:var(--accent);border:none;border-radius:4px;color:#fff;font-family:'DM Sans',sans-serif;font-size:0.9rem;font-weight:500;cursor:pointer;">
          Create Season
        </button>
        <div id="ns-message" style="font-size:0.82rem;display:none;"></div>
      </div>
    </div>

    <!-- Player Manager -->
    <div class="section-head" style="margin-top:2.5rem;">
      <div class="section-title">Player Manager</div>
      <div class="section-rule"></div>
    </div>
    <div style="font-size:0.82rem;color:var(--muted);margin-bottom:1rem;">Add members from the club roster to the league player list, or deactivate players who are no longer participating. Adding a member here makes them available for pod assignment in future seasons.</div>
    <div style="background:var(--surface);border:1px solid var(--border);border-radius:6px;padding:1.25rem;max-width:500px;margin-bottom:1rem;">
      <div style="display:flex;gap:8px;margin-bottom:1rem;">
        <select id="pm-new-name"
          style="flex:1;padding:8px 10px;background:var(--surface2);border:1px solid var(--border);border-radius:4px;color:var(--text);font-family:'DM Sans',sans-serif;font-size:0.85rem;appearance:none;">
          <option value="">Select member to add...</option>
          ${D.players.filter(p => p.active && !(leagueData.allPlayers||[]).some(lp => lp.name === p.name)).sort((a,b) => a.name.localeCompare(b.name)).map(p => `<option value="${p.name.replace(/"/g,'&quot;')}">${p.name}</option>`).join('')}
        </select>
        <button onclick="addLeaguePlayer()"
          style="padding:8px 14px;background:var(--accent);border:none;border-radius:4px;color:#fff;font-family:'DM Sans',sans-serif;font-size:0.85rem;font-weight:500;cursor:pointer;white-space:nowrap;">
          + Add
        </button>
      </div>
      <div id="pm-add-message" style="font-size:0.78rem;display:none;margin-bottom:10px;"></div>
      <div style="font-size:0.7rem;font-weight:500;letter-spacing:0.1em;text-transform:uppercase;color:var(--muted);margin-bottom:8px;">All Players</div>
      <div style="max-height:250px;overflow-y:auto;">
        ${(leagueData.allPlayers||[]).sort((a,b)=>a.name.localeCompare(b.name)).map(p=>`
          <div style="display:flex;justify-content:space-between;align-items:center;padding:5px 0;border-bottom:1px solid var(--border);">
            <span style="font-size:0.83rem;color:${p.active?'var(--text)':'var(--muted)'};">${p.name}${!p.active?'<span style="font-size:0.65rem;color:var(--faint);margin-left:6px;">inactive</span>':''}</span>
            <button onclick="toggleLeaguePlayer(${p.id},${!p.active})"
              style="font-size:0.65rem;padding:2px 8px;background:transparent;border:1px solid ${p.active?'var(--loss)':'var(--win)'};border-radius:3px;color:${p.active?'var(--loss)':'var(--win)'};cursor:pointer;">
              ${p.active?'Deactivate':'Reactivate'}
            </button>
          </div>`).join('')}
      </div>
    </div>

    <!-- End of season -->
    <div class="section-head" style="margin-top:2.5rem;">
      <div class="section-title">End of Season</div>
      <div class="section-rule"></div>
    </div>
    <div style="font-size:0.82rem;color:var(--muted);margin-bottom:1rem;">Archive the current season standings. Do this before setting up the new season.</div>
    <button onclick="archiveLeagueSeason()"
      style="padding:9px 18px;background:var(--surface2);border:1px solid var(--border);border-radius:4px;color:var(--muted);font-family:'DM Sans',sans-serif;font-size:0.82rem;cursor:pointer;"
      onmouseover="this.style.borderColor='var(--accent)';this.style.color='var(--accent)'"
      onmouseout="this.style.borderColor='var(--border)';this.style.color='var(--muted)'">
      💾 Archive Season &amp; Reset
    </button>
    <div id="lg-archive-message" style="font-size:0.82rem;display:none;margin-top:8px;"></div>`;

  container.innerHTML = html;
}

function updateLeaguePlayerDropdowns() {
  const podId = parseInt(document.getElementById('lg-pod').value);
  const podPlayers = (leagueData.players || []).filter(p => p.pod_id === podId).map(p => p.player_name);
  const opts = `<option value="">Select player...</option>` + podPlayers.map(p=>`<option value="${p}">${p}</option>`).join('');
  document.getElementById('lg-p1').innerHTML = opts;
  document.getElementById('lg-p2').innerHTML = opts;
  // clear any duplicate warning
  const msg = document.getElementById('lg-message');
  if (msg) { msg.style.display = 'none'; }
}

function checkLeagueDuplicate() {
  const podId = parseInt(document.getElementById('lg-pod').value);
  const p1 = document.getElementById('lg-p1').value;
  const p2 = document.getElementById('lg-p2').value;
  const msg = document.getElementById('lg-message');
  if (!p1 || !p2 || p1 === p2 || !podId) { msg.style.display = 'none'; return; }

  // check against already loaded games
  const existing = (leagueData.games || []).find(g =>
    g.pod_id === podId && (
      (g.player1 === p1 && g.player2 === p2) ||
      (g.player1 === p2 && g.player2 === p1)
    )
  );

  if (existing) {
    msg.style.display = 'block';
    msg.style.color = 'var(--loss)';
    msg.textContent = `⚠️ ${p1} vs ${p2} has already been played (${existing.bp1}-${existing.bp2})`;
    document.getElementById('lg-save-btn').disabled = true;
    document.getElementById('lg-save-btn').style.opacity = '0.4';
  } else {
    msg.style.display = 'none';
    document.getElementById('lg-save-btn').disabled = false;
    document.getElementById('lg-save-btn').style.opacity = '1';
  }
}

async function submitLeagueGame() {
  const msg = document.getElementById('lg-message');
  const pod_id = parseInt(document.getElementById('lg-pod').value);
  const player1 = document.getElementById('lg-p1').value;
  const player2 = document.getElementById('lg-p2').value;
  const bp1 = parseInt(document.getElementById('lg-bp1').value);
  const bp2 = parseInt(document.getElementById('lg-bp2').value);

  if (!pod_id || !player1 || !player2 || isNaN(bp1) || isNaN(bp2)) {
    msg.style.display = 'block'; msg.style.color = 'var(--loss)';
    msg.textContent = 'Please fill in all fields.'; return;
  }
  if (bp1 < 0 || bp1 > 100 || bp2 < 0 || bp2 > 100) {
    msg.style.display = 'block'; msg.style.color = 'var(--loss)';
    msg.textContent = 'Battle Points must be between 0 and 100.'; return;
  }
  if (player1 === player2) {
    msg.style.display = 'block'; msg.style.color = 'var(--loss)';
    msg.textContent = 'Players must be different.'; return;
  }

  const adminPin = getLeagueAdminPin();
  if (!adminPin) {
    msg.style.display = 'block'; msg.style.color = 'var(--loss)';
    msg.textContent = 'Enter admin PIN in the League admin section.'; return;
  }

  msg.style.display = 'block'; msg.style.color = 'var(--muted)';
  msg.textContent = 'Saving...';

  try {
    const res = await fetch(`${API}/league`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin: adminPin, pod_id, player1, player2, bp1, bp2 })
    });
    const data = await res.json();
    if (data.success) {
      msg.style.color = 'var(--win)';
      msg.textContent = data.approved ? '✓ Game saved and live!' : '⚠️ Wrong PIN -- went to queue.';
      document.getElementById('lg-bp1').value = '';
      document.getElementById('lg-bp2').value = '';
      leagueLoaded = false;
      await loadLeagueData();
      buildLeagueAdmin();
      renderLeague(); // refresh standings tab if open
    } else {
      msg.style.color = 'var(--loss)';
      msg.textContent = 'Error: ' + (data.error || 'Unknown');
    }
  } catch(e) {
    msg.style.color = 'var(--loss)';
    msg.textContent = 'Network error.';
  }
}

function openEditGame(id) {
  document.getElementById(`game-edit-${id}`).style.display = 'block';
}

function closeEditGame(id) {
  document.getElementById(`game-edit-${id}`).style.display = 'none';
  const msg = document.getElementById(`edit-msg-${id}`);
  if (msg) msg.style.display = 'none';
}

async function saveEditGame(id) {
  const bp1 = parseInt(document.getElementById(`edit-bp1-${id}`).value);
  const bp2 = parseInt(document.getElementById(`edit-bp2-${id}`).value);
  const msg = document.getElementById(`edit-msg-${id}`);
  const adminPin = getLeagueAdminPin();

  if (isNaN(bp1) || isNaN(bp2) || bp1 < 0 || bp1 > 100 || bp2 < 0 || bp2 > 100) {
    msg.style.display = 'block'; msg.style.color = 'var(--loss)';
    msg.textContent = 'BP must be 0-100'; return;
  }

  msg.style.display = 'block'; msg.style.color = 'var(--muted)';
  msg.textContent = 'Saving...';

  try {
    const res = await fetch(`${API}/league`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin: adminPin, gameId: id, bp1, bp2 })
    });
    const data = await res.json();
    if (data.success) {
      // Update score display inline without full rebuild
      document.getElementById(`game-score-${id}`).textContent = `${bp1}-${bp2}`;
      closeEditGame(id);
      // Refresh league data in background so standings update
      leagueLoaded = false;
      await loadLeagueData();
      buildLeagueAdmin();
    } else {
      msg.style.color = 'var(--loss)';
      msg.textContent = 'Error: ' + (data.error || 'Unknown');
    }
  } catch(e) {
    msg.style.color = 'var(--loss)';
    msg.textContent = 'Network error';
  }
}

async function approveLeagueGame(gameId, approved) {
  const adminPin = getLeagueAdminPin();
  try {
    const res = await fetch(`${API}/league`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin: adminPin, gameId, approved })
    });
    const data = await res.json();
    if (data.success) { leagueLoaded = false; await loadLeagueData(); buildLeagueAdmin(); }
    else alert('Error: ' + (data.error || 'Unknown'));
  } catch(e) { console.error(e); }
}

async function approvePlayoffGame(playoffId, approved) {
  const adminPin = getLeagueAdminPin();
  try {
    const res = await fetch(`${API}/league`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin: adminPin, playoffId, approved })
    });
    const data = await res.json();
    if (data.success) { leagueLoaded = false; await loadLeagueData(); buildLeagueAdmin(); if (activePod === 'playoffs') renderPod(); }
    else alert('Error: ' + (data.error || 'Unknown'));
  } catch(e) { console.error(e); }
}

// -- new season pod generator --
let _generatedPods = null;

function generateSeededPods() {
  const numPods = parseInt(document.getElementById('ns-num-pods').value);
  const selected = [...document.querySelectorAll('#ns-player-list input:checked')].map(c => c.value);
  if (selected.length < numPods * 2) {
    alert(`Need at least ${numPods * 2} players for ${numPods} pods.`); return;
  }

  // Seed by current season BP
  const games = leagueData.games || [];
  const bpMap = {};
  selected.forEach(p => { bpMap[p] = 0; });
  games.forEach(g => {
    if (bpMap[g.player1] !== undefined) bpMap[g.player1] += g.bp1;
    if (bpMap[g.player2] !== undefined) bpMap[g.player2] += g.bp2;
  });

  const sorted = [...selected].sort((a, b) => (bpMap[b] || 0) - (bpMap[a] || 0));

  // Snake draft
  const pods = Array.from({ length: numPods }, (_, i) => ({ number: i + 1, name: `Pod ${i + 1}`, players: [] }));
  sorted.forEach((player, i) => {
    const round = Math.floor(i / numPods);
    const podIdx = round % 2 === 0 ? i % numPods : numPods - 1 - (i % numPods);
    pods[podIdx].players.push(player);
  });

  _generatedPods = pods;
  window._podBpMap = bpMap; // expose for renderPodPreview to flag new players
  renderPodPreview();
  document.getElementById('ns-create-btn').style.display = 'block';
}

function renderPodPreview() {
  const preview = document.getElementById('ns-pods-preview');
  preview.style.display = 'block';
  const numPods = _generatedPods.length;

  preview.innerHTML = `
    <div style="font-size:0.72rem;color:var(--muted);margin-bottom:8px;">Preview -- use arrows to move players between pods:</div>
    <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:8px;">
      ${_generatedPods.map((pod, pi) => `
        <div style="background:var(--surface2);border:1px solid var(--border);border-radius:4px;padding:8px;">
          <div style="font-size:0.7rem;font-weight:500;color:var(--accent);margin-bottom:6px;">Pod ${pod.number} <span style="color:var(--muted);font-weight:400;">(${pod.players.length})</span></div>
          ${pod.players.map((p, i) => `
            <div style="display:flex;align-items:center;justify-content:space-between;padding:2px 0;border-bottom:1px solid var(--border);gap:4px;">
              <span style="font-size:0.78rem;color:${i===0?'var(--accent)':'var(--text)'};flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${p}">
                ${i===0?'🌟 ':''}${(window._podBpMap&&window._podBpMap[p]===0)?'🆕 ':''}${p}
              </span>
              <div style="display:flex;gap:2px;flex-shrink:0;">
                ${pi > 0 ? `<button onclick="movePlayer(${pi},${i},'left')" title="Move to Pod ${pi}" style="font-size:0.65rem;padding:1px 4px;background:transparent;border:1px solid var(--border);border-radius:2px;color:var(--muted);cursor:pointer;">←</button>` : ''}
                ${pi < numPods-1 ? `<button onclick="movePlayer(${pi},${i},'right')" title="Move to Pod ${pi+2}" style="font-size:0.65rem;padding:1px 4px;background:transparent;border:1px solid var(--border);border-radius:2px;color:var(--muted);cursor:pointer;">→</button>` : ''}
              </div>
            </div>`).join('')}
        </div>`).join('')}
    </div>
    <div style="font-size:0.72rem;color:var(--muted);margin-top:8px;">🌟 = top seed per pod · Arrows move a player to the adjacent pod</div>`;
}

function movePlayer(fromPodIdx, playerIdx, direction) {
  const toPodIdx = direction === 'left' ? fromPodIdx - 1 : fromPodIdx + 1;
  if (toPodIdx < 0 || toPodIdx >= _generatedPods.length) return;
  const player = _generatedPods[fromPodIdx].players.splice(playerIdx, 1)[0];
  _generatedPods[toPodIdx].players.push(player);
  renderPodPreview();
}

async function createNewSeason() {
  const msg = document.getElementById('ns-message');
  const name = document.getElementById('ns-name').value.trim();
  const adminPin = getLeagueAdminPin();

  if (!name) { msg.style.display='block'; msg.style.color='var(--loss)'; msg.textContent='Enter a season name.'; return; }
  if (!_generatedPods) { msg.style.display='block'; msg.style.color='var(--loss)'; msg.textContent='Generate pods first.'; return; }

  // Archive gate -- warn if current season still active
  if (leagueData.season?.active) {
    const proceed = confirm(
      `⚠️ The current season "${leagueData.season?.name || 'current'}" is still active and has not been archived.\n\n` +
      `Creating a new season will deactivate it without saving an archive.\n\n` +
      `Are you sure? Press Cancel to archive first (recommended).`
    );
    if (!proceed) return;
  }

  if (!confirm(`Create "${name}" with ${_generatedPods.length} pods?`)) return;

  msg.style.display = 'block'; msg.style.color = 'var(--muted)'; msg.textContent = 'Creating...';

  try {
    const res = await fetch(`${API}/league`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin: adminPin, name, pods: _generatedPods })
    });
    const data = await res.json();
    if (data.success) {
      msg.style.color = 'var(--win)';
      msg.textContent = `✓ ${name} created! Reload the page to see the new season.`;
      leagueLoaded = false;
    } else {
      msg.style.color = 'var(--loss)';
      msg.textContent = 'Error: ' + (data.error || 'Unknown');
    }
  } catch(e) { msg.style.color='var(--loss)'; msg.textContent='Network error.'; }
}

async function addLeaguePlayer() {
  const input = document.getElementById('pm-new-name');
  const msg = document.getElementById('pm-add-message');
  const name = input.value.trim();
  if (!name) { msg.style.display = 'block'; msg.style.color = 'var(--loss)'; msg.textContent = 'Please select a member.'; return; }
  const adminPin = getLeagueAdminPin();

  try {
    const res = await fetch(`${API}/league`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin: adminPin, type: 'add_player', name })
    });
    const data = await res.json();
    if (data.success) {
      msg.style.display = 'block'; msg.style.color = 'var(--win)';
      msg.textContent = `✓ ${name} added.`;
      input.value = '';
      leagueLoaded = false;
      await loadLeagueData();
      buildLeagueAdmin();
    } else {
      msg.style.display = 'block'; msg.style.color = 'var(--loss)';
      msg.textContent = 'Error: ' + (data.error || 'Unknown');
    }
  } catch(e) { msg.style.display='block'; msg.style.color='var(--loss)'; msg.textContent='Network error.'; }
}

async function toggleLeaguePlayer(playerId, active) {
  const adminPin = getLeagueAdminPin();
  try {
    const res = await fetch(`${API}/league`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin: adminPin, playerId, active })
    });
    const data = await res.json();
    if (data.success) {
      leagueLoaded = false;
      await loadLeagueData();
      buildLeagueAdmin();
    } else {
      alert('Error: ' + (data.error || 'Unknown'));
    }
  } catch(e) { console.error(e); }
}

async function archiveLeagueSeason() {
  const adminPin = getLeagueAdminPin();
  const msg = document.getElementById('lg-archive-message');
  const label = prompt('Enter archive label (e.g. "Season 1 -- 2025/26"):');
  if (!label) return;
  if (!confirm(`Archive "${label}" and mark season as inactive?`)) return;

  const snapshot = {
    season: leagueData.season,
    pods: (leagueData.pods || []).map(pod => {
      const podPlayers = (leagueData.players || []).filter(p => p.pod_id === pod.id).map(p => p.player_name);
      const podGames = (leagueData.games || []).filter(g => g.pod_id === pod.id);
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
      return { pod: pod.name, standings: Object.values(standings).sort((a,b) => b.pts - a.pts || b.bp - a.bp) };
    })
  };

  try {
    msg.style.display = 'block'; msg.style.color = 'var(--muted)'; msg.textContent = 'Archiving...';
    const res = await fetch(`${API}/league`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin: adminPin, label, snapshot })
    });
    const data = await res.json();
    if (data.success) {
      msg.style.color = 'var(--win)';
      msg.textContent = '✓ Season archived. Use New Season Setup above to start Season 2.';
      leagueLoaded = false;
    } else {
      msg.style.color = 'var(--loss)'; msg.textContent = 'Error: ' + (data.error || 'Unknown');
    }
  } catch(e) { msg.style.color='var(--loss)'; msg.textContent='Network error.'; }
}

// -- wizard type toggle --
function setWizardType(type) {
  const isTournament = type === 'tournament';
  document.getElementById('wiz-tournament-flow').style.display = isTournament ? 'block' : 'none';
  document.getElementById('wiz-league-flow').style.display = isTournament ? 'none' : 'block';
  document.getElementById('wiz-type-tournament').style.background = isTournament ? 'var(--accent)' : 'transparent';
  document.getElementById('wiz-type-tournament').style.borderColor = isTournament ? 'var(--accent)' : 'var(--border)';
  document.getElementById('wiz-type-tournament').style.color = isTournament ? '#fff' : 'var(--muted)';
  document.getElementById('wiz-type-league').style.background = isTournament ? 'transparent' : 'var(--accent)';
  document.getElementById('wiz-type-league').style.borderColor = isTournament ? 'var(--border)' : 'var(--accent)';
  document.getElementById('wiz-type-league').style.color = isTournament ? 'var(--muted)' : '#fff';

  // Populate pod dropdown when switching to league
  if (!isTournament && leagueData) {
    initLeagueSubMe();
  }
}

// When pod changes -- populate "Your name" with pod players


// Populate "Your name" dropdown with all league players, then auto-detect pod on selection
function initLeagueSubMe() {
  const meEl = document.getElementById('lg-sub-me');
  if (!meEl || !leagueData) return;
  const allPlayers = (leagueData.players || []).map(p => p.player_name).sort();
  meEl.innerHTML = '<option value="">Select your name...</option>';
  allPlayers.forEach(name => {
    const opt = document.createElement('option');
    opt.value = name; opt.textContent = name;
    meEl.appendChild(opt);
  });
}

// Auto-detect pod from selected player name, show pod info, populate opponents
function autoDetectPodAndOpponents() {
  const me = document.getElementById('lg-sub-me').value;
  const oppEl = document.getElementById('lg-sub-opponent');
  const podInfoEl = document.getElementById('lg-sub-pod-info');
  const podSel = document.getElementById('lg-sub-pod');

  oppEl.innerHTML = '<option value="">Select opponent...</option>';
  if (podInfoEl) podInfoEl.style.display = 'none';

  if (!me || !leagueData) return;

  // Find the player's pod
  const playerEntry = (leagueData.players || []).find(p => p.player_name === me);
  if (!playerEntry) {
    if (podInfoEl) { podInfoEl.style.display = 'block'; podInfoEl.textContent = '⚠️ You are not registered in any league pod this season.'; }
    return;
  }

  const podId = playerEntry.pod_id;
  const pod = (leagueData.pods || []).find(p => p.id === podId);
  const podName = pod?.name || `Pod ${podId}`;

  // Set hidden pod selector
  if (podSel) { podSel.innerHTML = `<option value="${podId}" selected>${podName}</option>`; }

  // Show pod info
  if (podInfoEl) {
    podInfoEl.style.display = 'block';
    podInfoEl.innerHTML = `📍 You are in <strong style="color:var(--text);">${podName}</strong>`;
  }

  // Populate opponents from same pod
  const podPlayers = (leagueData.players || [])
    .filter(p => p.pod_id === podId && p.player_name !== me)
    .map(p => p.player_name)
    .sort();

  if (!podPlayers.length) {
    oppEl.innerHTML = '<option value="">No other players in your pod</option>';
    return;
  }
  podPlayers.forEach(name => {
    const opt = document.createElement('option');
    opt.value = name; opt.textContent = name;
    oppEl.appendChild(opt);
  });
}

async function submitLeagueGameAsPlayer() {
  const msg = document.getElementById('lg-sub-message');
  const pod_id = parseInt(document.getElementById('lg-sub-pod').value);
  const me = document.getElementById('lg-sub-me').value;
  const opponent = document.getElementById('lg-sub-opponent').value;
  const mybp = parseInt(document.getElementById('lg-sub-mybp').value);
  const oppbp = parseInt(document.getElementById('lg-sub-oppbp').value);

  msg.style.display = 'block';
  if (!me) { msg.style.color='var(--loss)'; msg.textContent='Please select your name.'; return; }
  if (!pod_id) { msg.style.color='var(--loss)'; msg.textContent='Could not detect your pod -- are you registered in the league this season?'; return; }
  if (!opponent) { msg.style.color='var(--loss)'; msg.textContent='Please select your opponent.'; return; }
  if (isNaN(mybp) || isNaN(oppbp)) { msg.style.color='var(--loss)'; msg.textContent='Please enter battle points for both players.'; return; }
  if (mybp < 0 || mybp > 100 || oppbp < 0 || oppbp > 100) { msg.style.color='var(--loss)'; msg.textContent='Battle points must be between 0 and 100.'; return; }
  if (me === opponent) { msg.style.color='var(--loss)'; msg.textContent="You can't play yourself!"; return; }

  msg.style.color = 'var(--muted)';
  msg.textContent = 'Submitting...';

  try {
    const res = await fetch(`${API}/league`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin: TEAM_PIN, pod_id, player1: me, player2: opponent, bp1: mybp, bp2: oppbp })
    });
    const data = await res.json();
    if (data.success) {
      msg.style.color = 'var(--win)';
      msg.textContent = '✓ League result submitted! Pending admin approval before it appears in standings.';
      document.getElementById('lg-sub-pod').innerHTML = '';
      document.getElementById('lg-sub-me').value = '';
      document.getElementById('lg-sub-opponent').innerHTML = '<option value="">Select your name first...</option>';
      document.getElementById('lg-sub-pod-info').style.display = 'none';
      document.getElementById('lg-sub-mybp').value = '';
      document.getElementById('lg-sub-oppbp').value = '';
    } else {
      msg.style.color = 'var(--loss)';
      msg.textContent = 'Error: ' + (data.error || 'Unknown');
    }
  } catch(e) {
    msg.style.color = 'var(--loss)';
    msg.textContent = 'Network error -- try again.';
  }
}

// -- wizard state --
let wizardEventName = '';
let wizardEventFormat = '';
let wizardIsNewEvent = false;
let wizardNewEventData = null;

function wizardSearchEvent(val) {
  const resultsEl = document.getElementById('wiz-search-results');
  const newFieldsEl = document.getElementById('wiz-new-event-fields');
  if (!val.trim() || val.length < 2) {
    resultsEl.style.display = 'none';
    newFieldsEl.style.display = 'none';
    return;
  }

  // Search only dbEvents -- D.events is populated from dbEvents anyway so no duplication
  const allEvents = dbEvents.map(e => ({ name: e.name, format: e.format, date: e.event_date, source: 'db' }));

  const matches = allEvents.filter(e =>
    e.name.toLowerCase().includes(val.toLowerCase().trim())
  ).slice(0, 5);

  if (matches.length) {
    resultsEl.style.display = 'block';
    newFieldsEl.style.display = 'none';
    resultsEl.innerHTML = `
      <div style="font-size:0.72rem;color:var(--muted);margin-bottom:6px;">Matching events -- click to select:</div>
      ${matches.map((e, i) => `
        <div data-idx="${i}"
          style="padding:8px 12px;background:var(--surface2);border:1px solid var(--border);border-radius:4px;cursor:pointer;margin-bottom:4px;transition:border-color 0.15s;"
          onmouseover="this.style.borderColor='var(--accent)'" onmouseout="this.style.borderColor='var(--border)'">
          <div style="font-size:0.85rem;color:var(--text);">${e.name}</div>
          <div style="font-size:0.7rem;color:var(--muted);">${e.date} · ${e.format}</div>
        </div>`).join('')}
      <div onclick="wizardShowNewEventFields()"
        style="padding:8px 12px;background:transparent;border:1px dashed var(--border);border-radius:4px;cursor:pointer;margin-bottom:4px;font-size:0.82rem;color:var(--muted);text-align:center;"
        onmouseover="this.style.borderColor='var(--accent)';this.style.color='var(--accent)'" onmouseout="this.style.borderColor='var(--border)';this.style.color='var(--muted)'">
        + None of these -- create new event
      </div>`;

    // Use event delegation to avoid apostrophe issues in onclick attributes
    resultsEl.querySelectorAll('[data-idx]').forEach((el, i) => {
      el.addEventListener('click', () => wizardSelectEvent(matches[i].name, matches[i].format));
    });
  } else {
    resultsEl.style.display = 'none';
    if (val.length >= 3) checkEventDuplicate(val);
    newFieldsEl.style.display = 'block';
  }
}

function wizardSelectEvent(name, format) {
  wizardEventName = name;
  wizardEventFormat = format;
  wizardIsNewEvent = false;

  // Duplicate detection -- check if this player has already submitted for this event
  const warnEl = document.getElementById('ev-duplicate-warning');
  const selectedPlayer = document.getElementById('wiz-player')?.value || '';
  if (warnEl) warnEl.style.display = 'none';

  if (selectedPlayer) {
    // Check approved results
    const alreadyApproved = getActiveEvents().some(ev =>
      ev.name.toLowerCase() === name.toLowerCase() &&
      (ev.results || []).some(r => r.player === selectedPlayer)
    );
    // Check pending submissions
    const alreadyPending = (pendingSubmissions || []).some(s =>
      s.event_name?.toLowerCase() === name.toLowerCase() &&
      s.player_name === selectedPlayer
    );
    if (alreadyApproved || alreadyPending) {
      if (warnEl) {
        warnEl.textContent = alreadyApproved
          ? `${selectedPlayer} already has an approved result for ${name}.`
          : `${selectedPlayer} already has a pending submission for ${name}.`;
        warnEl.style.display = 'block';
      }
    }
  }

  wizardShowStep2();
}

function wizardShowNewEventFields() {
  document.getElementById('wiz-search-results').style.display = 'none';
  document.getElementById('wiz-new-event-fields').style.display = 'block';
}

async function wizardCreateAndContinue() {
  const name = document.getElementById('wiz-event-search').value.trim();
  const date = document.getElementById('wiz-ev-date').value.trim();
  const sortDate = parseInt(document.getElementById('wiz-ev-sortdate').value) || 0;
  const format = document.getElementById('wiz-ev-format').value;
  const players = parseInt(document.getElementById('wiz-ev-players').value) || 0;
  const bcp = document.getElementById('wiz-ev-bcp').value.trim();

  if (!name || !date || !sortDate || !format) {
    alert('Please fill in event name, date, sort date and format.');
    return;
  }

  wizardEventName = name;
  wizardEventFormat = format;
  wizardIsNewEvent = true;
  wizardNewEventData = { name, event_date: date, sort_date: sortDate, format, total_players: players, bcp_url: bcp };
  wizardShowStep2();
}

function wizardShowStep2() {
  document.getElementById('wiz-tournament-flow').style.display = 'none';
  document.getElementById('wizard-step2').style.display = 'block';
  document.getElementById('wiz-event-label').textContent = wizardEventName + (wizardEventFormat ? ' · ' + wizardEventFormat : '');

  // populate player dropdown
  const playerSel = document.getElementById('wiz-player');
  if (playerSel.options.length === 1) {
    D.players.forEach(p => {
      const opt = document.createElement('option');
      opt.value = p.name; opt.textContent = p.name;
      playerSel.appendChild(opt);
    });
  }

  // populate faction dropdown
  const factionSel = document.getElementById('wiz-faction');
  if (factionSel.options.length === 1) {
    ALL_FACTIONS.forEach(f => {
      const opt = document.createElement('option');
      opt.value = f; opt.textContent = f;
      factionSel.appendChild(opt);
    });
  }

  // Show/hide subteam based on format
  wizardUpdateSubteamVisibility();

  // Hide total players field for existing events (already in DB)
  const totalWrap = document.getElementById('wiz-total')?.closest('div')?.parentElement;
  if (totalWrap) totalWrap.style.display = wizardIsNewEvent ? '' : 'none';
}

function wizardAutoSortDate(val) {
  // Parses "3-4 May 2026", "11 Apr 2026", "May 2026" etc → YYYYMMDD sort date
  const MONTHS = {jan:1,feb:2,mar:3,apr:4,may:5,jun:6,jul:7,aug:8,sep:9,oct:10,nov:11,dec:12};
  const s = val.trim().toLowerCase();
  // Try: one or two day numbers, then month, then year e.g. "3-4 may 2026" or "11 apr 2026"
  const mDay = s.match(/(\d{1,2})[\s-\--]+\d{0,2}\s*([a-z]+)\s+(\d{4})/);
  if (mDay && MONTHS[mDay[2]] && parseInt(mDay[3]) > 2020) {
    const sortDate = parseInt(mDay[3]) * 10000 + MONTHS[mDay[2]] * 100 + parseInt(mDay[1]);
    const el = document.getElementById('wiz-ev-sortdate');
    if (el && !el.value) el.value = sortDate;
    return;
  }
  // Fallback: month + year only e.g. "May 2026" → first of month
  const mMon = s.match(/([a-z]+)[\s\-]+(\d{4})/);
  if (mMon && MONTHS[mMon[1]] && parseInt(mMon[2]) > 2020) {
    const sortDate = parseInt(mMon[2]) * 10000 + MONTHS[mMon[1]] * 100 + 1;
    const el = document.getElementById('wiz-ev-sortdate');
    if (el && !el.value) el.value = sortDate;
  }
}

function wizardUpdateSubteamVisibility() {
  const format = document.getElementById('wiz-ev-format')?.value || wizardEventFormat;
  const subteamWrap = document.getElementById('wiz-subteam-wrap');
  if (subteamWrap) subteamWrap.style.display = format === 'Teams' ? '' : 'none';
}

function wizardReset() {
  wizardNewEventData = null;
  document.getElementById('wiz-tournament-flow').style.display = 'block';
  document.getElementById('wizard-step2').style.display = 'none';
  document.getElementById('wiz-event-search').value = '';
  document.getElementById('wiz-search-results').style.display = 'none';
  document.getElementById('wiz-new-event-fields').style.display = 'none';
  document.getElementById('wiz-message').style.display = 'none';
  // Reset checkboxes
  const shadow = document.getElementById('wiz-shadow');
  const dropped = document.getElementById('wiz-dropped');
  if (shadow) shadow.checked = false;
  if (dropped) dropped.checked = false;
  // Reset subteam and total player field visibility
  const subteamWrap = document.getElementById('wiz-subteam-wrap');
  if (subteamWrap) subteamWrap.style.display = 'none';
  const totalEl = document.getElementById('wiz-total');
  const totalWrap = totalEl?.closest('div')?.parentElement;
  if (totalWrap) totalWrap.style.display = '';
}

async function wizardSubmitResult() {
  const msg = document.getElementById('wiz-message');
  const player = document.getElementById('wiz-player').value;
  const faction = document.getElementById('wiz-faction').value;
  const placing = parseInt(document.getElementById('wiz-placing').value) || null;
  const total = parseInt(document.getElementById('wiz-total').value) || null;
  const wins = parseInt(document.getElementById('wiz-wins').value) || 0;
  const losses = parseInt(document.getElementById('wiz-losses').value) || 0;
  const draws = parseInt(document.getElementById('wiz-draws').value) || 0;
  const subteam = document.getElementById('wiz-subteam').value.trim() || null;
  const shadow = document.getElementById('wiz-shadow')?.checked || false;
  const dropped = document.getElementById('wiz-dropped')?.checked || false;

  if (!player || !faction) {
    msg.style.display = 'block'; msg.style.color = 'var(--loss)';
    msg.textContent = 'Please select your name and faction.';
    return;
  }

  // Check for duplicate -- player already has a result for this event in DB
  if (!wizardIsNewEvent) {
    const dbEv = dbEvents.find(e => e.name === wizardEventName);
    if (dbEv) {
      const alreadyIn = (dbEv.results || []).some(r => r.player_name === player);
      if (alreadyIn) {
        msg.style.display = 'block'; msg.style.color = '#f0c040';
        msg.textContent = `⚠️ ${player} already has a result recorded for ${wizardEventName}. If it's wrong, use "Fix an Error in My Stats" instead.`;
        return;
      }
    }
  }
  // Sanity check W/L/D vs format
  const totalGames = wins + losses + draws;
  const expectedRounds = wizardEventFormat === 'GT' ? 6 : wizardEventFormat === 'RTT' ? 3 : null;
  if (expectedRounds && totalGames > expectedRounds) {
    msg.style.display = 'block'; msg.style.color = '#f0c040';
    msg.textContent = `⚠️ ${totalGames} games entered but ${wizardEventFormat}s typically have ${expectedRounds} rounds -- double check your record.`;
    // Don't block -- just warn. Allow submit after 2 seconds
    await new Promise(r => setTimeout(r, 2000));
  }

  msg.style.display = 'block'; msg.style.color = 'var(--muted)';
  msg.textContent = 'Submitting...';

  // Guard: null check in case wizard state was lost
  if (wizardIsNewEvent && !wizardNewEventData) {
    msg.style.display = 'block'; msg.style.color = 'var(--loss)';
    msg.textContent = 'Something went wrong -- use the Change event button and re-select your event.'; return;
  }
  if (!wizardIsNewEvent && !wizardEventName) {
    msg.style.display = 'block'; msg.style.color = 'var(--loss)';
    msg.textContent = 'Something went wrong -- use the Change event button and re-select your event.'; return;
  }

  try {
    // If new event -- store as pending event submission for admin approval
    // (members can't create events directly)
    if (wizardIsNewEvent) {
      const ts = Date.now();
      const submission = {
        type: 'new_event',
        event: wizardNewEventData,
        result: { player_name: player, faction, placing, wins, losses, draws, subteam, shadow, dropped },
        submittedAt: new Date().toISOString(),
        status: 'pending'
      };
      const res = await fetch(`${API}/submissions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          player_name: player,
          event_name: wizardNewEventData.name,
          event_format: wizardNewEventData.format || 'GT',
          faction,
          place: placing,
          total_players: wizardNewEventData.total_players || 0,
          wins, losses, draws, subteam, shadow, dropped
        })
      });
      const data = await res.json();
      if (data.success) {
        msg.style.color = 'var(--win)';
        msg.textContent = '✓ Event submitted for admin approval -- it will appear in the stats once approved.';
        setTimeout(wizardReset, 3000);
      } else {
        msg.style.color = 'var(--loss)';
        msg.textContent = 'Error: ' + (data.error || 'Unknown error');
      }
    } else {
      // submit to approval queue
      const subRes = await fetch(`${API}/submissions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          player_name: player,
          event_name: wizardEventName,
          event_format: wizardEventFormat,
          faction, place: placing,
          total_players: total,
          wins, losses, draws, subteam, shadow, dropped
        })
      });
      const subData = await subRes.json();
      if (subData.success) {
        msg.style.color = 'var(--win)';
        msg.textContent = '✓ Result submitted! It will appear in the stats once approved.';
        setTimeout(wizardReset, 3000);
      } else {
        msg.style.color = 'var(--loss)';
        msg.textContent = 'Error: ' + (subData.error || 'Unknown error');
      }
    }
  } catch(e) {
    msg.style.color = 'var(--loss)';
    msg.textContent = 'Network error -- try again.';
  }
}

// -- admin PIN --
let _adminPinTimer = null;
function checkAdminPin(val) {
  if (val.length < 4) return;
  clearTimeout(_adminPinTimer);
  _adminPinTimer = setTimeout(() => {
    const errEl = document.getElementById('admin-pin-error');
    fetch(`${API}/submissions?pin=${encodeURIComponent(val)}`)
      .then(r => r.json())
      .then(async data => {
        if (data.submissions !== undefined) {
          window._adminPin = val;
          sessionStorage.setItem('pssn_admin_pin', val);
          document.getElementById('admin-gate').style.display = 'none';
          document.getElementById('admin-content').style.display = 'block';
          await loadAdminCorrections();
          await loadAdminEventSubmissions();
          await loadResultSubmissions();
          loadDbEvents();
          loadAndRenderMembers();
          buildAdminTriage();
        } else {
          errEl.style.display = 'block';
          document.getElementById('admin-pin-input').value = '';
          setTimeout(() => { errEl.style.display = 'none'; }, 2000);
        }
      })
      .catch(() => {
        errEl.style.display = 'block';
        document.getElementById('admin-pin-input').value = '';
        setTimeout(() => { errEl.style.display = 'none'; }, 2000);
      });
  }, 600);
}

let _leaguePinTimer = null;
function checkLeagueAdminPin(val) {
  if (val.length < 4) return;
  // Debounce -- wait 600ms after last keystroke before checking
  // This prevents Chrome autocomplete from triggering on partial values
  clearTimeout(_leaguePinTimer);
  _leaguePinTimer = setTimeout(() => {
    const errEl = document.getElementById('league-admin-pin-error');
    fetch(`${API}/submissions?pin=${encodeURIComponent(val)}`)
      .then(r => r.json())
      .then(async data => {
        if (data.submissions !== undefined) {
          window._leagueAdminPin = val;
          document.getElementById('league-admin-gate').style.display = 'none';
          const section = document.getElementById('league-admin-section');
          section.style.display = 'block';
          // Always force a fresh reload before building admin so pending items are current
          leagueLoaded = false;
          await loadLeagueData();
          leagueLoaded = true;
          buildLeagueAdmin();
        } else {
          errEl.style.display = 'block';
          document.getElementById('league-admin-pin-input').value = '';
          window._leagueAdminPin = null;
          setTimeout(() => { errEl.style.display = 'none'; }, 2000);
        }
      })
      .catch(() => {
        errEl.style.display = 'block';
        document.getElementById('league-admin-pin-input').value = '';
        window._leagueAdminPin = null;
        setTimeout(() => { errEl.style.display = 'none'; }, 2000);
      });
  }, 600);
}

// Helper -- always get the most current league admin PIN from the input field
function getLeagueAdminPin() {
  return document.getElementById('league-admin-pin-input')?.value || window._leagueAdminPin || '';
}

function timeAgo(isoString) {
  if (!isoString) return '';
  const diff = Date.now() - new Date(isoString).getTime();
  const mins = Math.floor(diff / 60000);
  const hrs = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);
  if (mins < 2) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  if (hrs < 24) return `${hrs}h ago`;
  if (days < 7) return `${days}d ago`;
  return new Date(isoString).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

function getAdminPin() {
  return document.getElementById('admin-pin-input')?.value 
    || window._adminPin 
    || sessionStorage.getItem('pssn_admin_pin') 
    || '';
}

// -- Refresh all player dropdowns across the site after member changes --
function refreshPlayerDropdowns() {
  const playerNames = D.players.map(p => p.name).filter(Boolean).sort();
  const playerOpts = `<option value="">Select player...</option>` + playerNames.map(n => `<option value="${n}">${n}</option>`).join('');
  // Wizard player dropdown
  const wizPlayer = document.getElementById('wiz-player');
  if (wizPlayer) {
    wizPlayer.innerHTML = playerOpts;
    // Pre-select stored member
    const storedForWiz = localStorage.getItem('pssn_member') || '';
    if (storedForWiz && [...wizPlayer.options].some(o => o.value === storedForWiz)) {
      wizPlayer.value = storedForWiz;
    }
  }
  // League submit dropdowns
  const lgMe = document.getElementById('lg-sub-me');
  if (lgMe) lgMe.innerHTML = `<option value="">Select pod first...</option>`;
  // Correction player dropdown
  const corrPlayer = document.getElementById('corr-player');
  if (corrPlayer) {
    corrPlayer.innerHTML = `<option value="">Select your name...</option>` + playerNames.map(n => `<option value="${n}">${n}</option>`).join('');
  }
  // Who's going grid -- re-render if visible
  const wgGrid = document.getElementById('whos-going-grid');
  if (wgGrid && wgGrid.innerHTML.length > 100) renderWhosGoing();
}


const ALL_FACTIONS = [
  'Adepta Sororitas','Adeptus Custodes','Adeptus Mechanicus','Aeldari',
  'Astra Militarum','Black Templars','Blood Angels','Chaos Daemons',
  'Chaos Knights','Chaos Space Marines','Dark Angels','Death Guard',
  'Deathwatch','Drukhari','Emperor\'s Children','Genestealer Cult',
  'Grey Knights','Imperial Knights','Iron Hands','Leagues of Votann',
  'Necrons','Orks','Raven Guard','Salamanders','Space Marines',
  'Space Wolves','T\'au Empire','Thousand Sons','Tyranids',
  'Ultramarines','White Scars','World Eaters'
].sort();

let evResultRows = [];
let dbEvents = [];

// -- Member Manager --
async function loadAndRenderMembers() {
  const listEl = document.getElementById('member-list');
  const countEl = document.getElementById('member-count');
  if (!listEl) return;
  listEl.innerHTML = `<div style="font-size:0.82rem;color:var(--muted);">Loading...</div>`;
  try {
    const res = await fetch(`${API}/players`);
    const data = await res.json();
    const all = (data.players || []).sort((a,b) => a.name.localeCompare(b.name));
    if (countEl) countEl.textContent = all.length;

    const ALL_FACTIONS_LIST = [
      'Adepta Sororitas','Adeptus Custodes','Adeptus Mechanicus','Aeldari',
      'Astra Militarum','Black Templars','Blood Angels','Chaos Daemons',
      'Chaos Knights','Chaos Space Marines','Dark Angels','Death Guard',
      'Deathwatch','Drukhari',"Emperor's Children",'Genestealer Cult',
      'Grey Knights','Imperial Knights','Iron Hands','Leagues of Votann',
      'Necrons','Orks','Raven Guard','Salamanders','Space Marines',
      'Space Wolves',"T'au Empire",'Thousand Sons','Tyranids',
      'Ultramarines','White Scars','World Eaters'
    ].sort();

    listEl.innerHTML = all.map(p => {
      const factionTags = (p.factions || []).length
        ? (p.factions).map(f => `<span style="font-size:0.68rem;padding:2px 7px;background:var(--surface2);border:1px solid var(--border);border-radius:3px;color:var(--muted);">${f}</span>`).join('')
        : `<span style="font-size:0.72rem;color:var(--faint);font-style:italic;">No factions set</span>`;
      // Store factions as a data attribute to avoid JSON/quote issues in onclick
      const factionsAttr = encodeURIComponent(JSON.stringify(p.factions || []));
      return `
      <div data-name="${p.name.toLowerCase()}" style="background:var(--surface);border:1px solid var(--border);border-radius:6px;padding:12px 14px;margin-bottom:8px;opacity:${p.active ? '1' : '0.5'};">
        <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:10px;">
          <div style="flex:1;min-width:0;">
            <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;">
              <span class="member-name" style="font-size:0.88rem;color:var(--text);font-weight:400;">${p.name}</span>
              ${!p.active ? '<span style="font-size:0.62rem;background:var(--surface2);border:1px solid var(--border);color:var(--faint);padding:1px 6px;border-radius:3px;">Inactive</span>' : ''}
            </div>
            <div style="display:flex;flex-wrap:wrap;gap:4px;margin-bottom:8px;">${factionTags}</div>
          </div>
          <div style="display:flex;gap:6px;flex-shrink:0;">
            <button onclick="openEditMember(${p.id}, '${p.name.replace(/'/g,"\\'")}', decodeURIComponent('${factionsAttr}'))"
              style="font-size:0.72rem;padding:4px 10px;background:transparent;border:1px solid var(--border);border-radius:3px;color:var(--muted);cursor:pointer;"
              onmouseover="this.style.borderColor='var(--accent)';this.style.color='var(--accent)'"
              onmouseout="this.style.borderColor='var(--border)';this.style.color='var(--muted)'">Edit</button>
            <button onclick="toggleMember(${p.id}, ${!p.active})"
              style="font-size:0.72rem;padding:4px 10px;background:transparent;border:1px solid ${p.active ? 'var(--loss)' : 'var(--win)'};border-radius:3px;color:${p.active ? 'var(--loss)' : 'var(--win)'};cursor:pointer;">
              ${p.active ? 'Deactivate' : 'Reactivate'}
            </button>
          </div>
        </div>
      </div>`;
    }).join('');
  } catch(e) {
    if (listEl) listEl.innerHTML = `<div style="font-size:0.82rem;color:var(--loss);">Failed to load members.</div>`;
  }
}

async function addMember() {
  const input = document.getElementById('member-new-name');
  const msg = document.getElementById('member-add-message');
  const name = input?.value.trim();
  if (!name) return;
  const adminPin = getAdminPin();
  try {
    const res = await fetch(`${API}/players`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin: adminPin, name, factions: [] })
    });
    const data = await res.json();
    if (data.success) {
      msg.style.display = 'block'; msg.style.color = 'var(--win)';
      msg.textContent = `✓ ${name} added.`;
      input.value = '';
      // Refresh D.players in memory and reload from DB
      await loadPlayers();
      // Refresh player dropdowns across the site
      refreshPlayerDropdowns();
      // Refresh wizard player dropdown if already populated
      const wizSel = document.getElementById('wiz-player');
      if (wizSel && wizSel.options.length > 1) {
        const opt = document.createElement('option');
        opt.value = name; opt.textContent = name;
        wizSel.appendChild(opt);
      }
      await loadAndRenderMembers();
      // Refresh league data so new member appears in league dropdowns immediately
      leagueLoaded = false;
      setTimeout(() => { msg.style.display = 'none'; }, 3000);
    } else {
      msg.style.display = 'block'; msg.style.color = 'var(--loss)';
      msg.textContent = 'Error: ' + (data.error || 'Unknown');
    }
  } catch(e) {
    msg.style.display = 'block'; msg.style.color = 'var(--loss)';
    msg.textContent = 'Network error.';
  }
}

function openEditMember(id, name, factionsEncoded) {
  // factionsEncoded is either a JSON string or URL-encoded JSON
  let currentFactions = [];
  try {
    const decoded = typeof factionsEncoded === 'string' && factionsEncoded.startsWith('%')
      ? JSON.parse(decodeURIComponent(factionsEncoded))
      : (typeof factionsEncoded === 'string' ? JSON.parse(factionsEncoded) : factionsEncoded);
    currentFactions = Array.isArray(decoded) ? decoded : [];
  } catch(e) { currentFactions = []; }
  const ALL_FACTIONS = [
    'Adepta Sororitas','Adeptus Custodes','Adeptus Mechanicus','Aeldari',
    'Astra Militarum','Black Templars','Blood Angels','Chaos Daemons',
    'Chaos Knights','Chaos Space Marines','Dark Angels','Death Guard',
    'Deathwatch','Drukhari',"Emperor's Children",'Genestealer Cult',
    'Grey Knights','Imperial Knights','Iron Hands','Leagues of Votann',
    'Necrons','Orks','Raven Guard','Salamanders','Space Marines',
    "Space Wolves","T'au Empire",'Thousand Sons','Tyranids',
    'Ultramarines','White Scars','World Eaters'
  ].sort();

  let modal = document.getElementById('edit-member-modal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'edit-member-modal';
    modal.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.75);z-index:9999;display:flex;align-items:center;justify-content:center;padding:16px;';
    document.body.appendChild(modal);
  }

  modal.innerHTML = `
    <div style="background:var(--bg);border:1px solid var(--border);border-radius:8px;padding:1.5rem;max-width:460px;width:100%;max-height:90vh;overflow-y:auto;">
      <div style="font-size:0.7rem;color:var(--muted);text-transform:uppercase;letter-spacing:0.1em;margin-bottom:4px;">Edit Member</div>
      <div style="font-size:1rem;color:var(--text);font-weight:400;margin-bottom:16px;">${name}</div>

      <div style="font-size:0.72rem;color:var(--muted);text-transform:uppercase;letter-spacing:0.08em;margin-bottom:8px;">Factions</div>
      <div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:16px;" id="em-faction-grid">
        ${ALL_FACTIONS.map(f => {
          const sel = currentFactions.includes(f);
          return `<button
            onclick="this.dataset.sel = this.dataset.sel==='1' ? '0' : '1'; this.style.background=this.dataset.sel==='1'?'var(--accent)':'transparent'; this.style.borderColor=this.dataset.sel==='1'?'var(--accent)':'var(--border)'; this.style.color=this.dataset.sel==='1'?'#fff':'var(--muted)';"
            data-faction="${f}" data-sel="${sel ? '1' : '0'}"
            style="font-size:0.75rem;padding:4px 10px;border-radius:4px;cursor:pointer;font-family:'DM Sans',sans-serif;
                   background:${sel ? 'var(--accent)' : 'transparent'};
                   border:1px solid ${sel ? 'var(--accent)' : 'var(--border)'};
                   color:${sel ? '#fff' : 'var(--muted)'};">
            ${f}
          </button>`;
        }).join('')}
      </div>

      <div id="em-msg" style="display:none;font-size:0.78rem;padding:6px 10px;border-radius:4px;margin-bottom:10px;"></div>
      <div style="display:flex;gap:8px;justify-content:flex-end;">
        <button onclick="document.getElementById('edit-member-modal').style.display='none'"
          style="padding:8px 16px;background:transparent;border:1px solid var(--border);border-radius:4px;color:var(--muted);font-family:'DM Sans',sans-serif;font-size:0.85rem;cursor:pointer;">Cancel</button>
        <button onclick="saveEditMember(${id})"
          style="padding:8px 16px;background:var(--accent);border:none;border-radius:4px;color:#fff;font-family:'DM Sans',sans-serif;font-size:0.85rem;font-weight:500;cursor:pointer;">Save</button>
      </div>
    </div>`;

  modal.style.display = 'flex';
  modal.onclick = e => { if (e.target === modal) modal.style.display = 'none'; };
}

async function saveEditMember(id) {
  const grid = document.getElementById('em-faction-grid');
  const msg = document.getElementById('em-msg');
  const factions = [...grid.querySelectorAll('button[data-sel="1"]')].map(b => b.dataset.faction);
  const adminPin = getAdminPin();

  msg.style.display = 'block'; msg.style.background = 'var(--surface2)'; msg.style.color = 'var(--muted)';
  msg.textContent = 'Saving...';
  try {
    const res = await fetch(`${API}/players`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin: adminPin, id, factions })
    });
    const data = await res.json();
    if (data.success) {
      msg.style.background = 'var(--win-bg)'; msg.style.color = 'var(--win)';
      msg.textContent = '✓ Saved';
      await loadAndRenderMembers();
      setTimeout(() => { document.getElementById('edit-member-modal').style.display = 'none'; }, 600);
    } else {
      msg.style.background = 'var(--loss-bg)'; msg.style.color = 'var(--loss)';
      msg.textContent = 'Error: ' + (data.error || 'Unknown');
    }
  } catch(e) {
    msg.style.background = 'var(--loss-bg)'; msg.style.color = 'var(--loss)';
    msg.textContent = 'Network error.';
  }
}

async function toggleMember(playerId, active) {
  if (!active && !confirm('Deactivate this member? They will be removed from dropdowns but their results are kept.')) return;
  const adminPin = getAdminPin();
  try {
    const res = await fetch(`${API}/players`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin: adminPin, id: playerId, active })
    });
    const data = await res.json();
    if (data.success) await loadAndRenderMembers();
    else alert('Error: ' + (data.error || 'Unknown'));
  } catch(e) { console.error(e); }
}


// -- Team Name Aliases --
const ALIAS_KEY = '_team_aliases_19700101';

function aliasGetRegistry() {
  try {
    const raw = attendanceData[ALIAS_KEY];
    return raw ? JSON.parse(raw) : {};
  } catch(e) { return {}; }
}

async function aliasSaveRegistry(registry) {
  await loadAttendance(true);
  await fetch(`${API}/attendance`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      player_name: ALIAS_KEY,
      event_sort_date: 19700101,
      status: JSON.stringify(registry),
      pin: getAdminPin()
    })
  });
  attendanceData[ALIAS_KEY] = JSON.stringify(registry);
}

function aliasResolve(name) {
  // Returns canonical name if alias exists, otherwise returns name unchanged
  const registry = aliasGetRegistry();
  return registry[name] || name;
}

function aliasRenderList() {
  const el = document.getElementById('alias-list');
  if (!el) return;
  const registry = aliasGetRegistry();
  const entries = Object.entries(registry);
  if (!entries.length) {
    el.innerHTML = `<div style="font-size:0.82rem;color:var(--muted);padding:8px 0;">No aliases defined yet.</div>`;
    return;
  }
  el.innerHTML = `
    <div style="background:var(--surface);border:1px solid var(--border);border-radius:6px;overflow:hidden;">
      <div style="display:grid;grid-template-columns:1fr 1fr auto;gap:0;border-bottom:1px solid var(--border);padding:8px 14px;">
        <div style="font-size:0.7rem;color:var(--muted);text-transform:uppercase;letter-spacing:0.06em;">Variant (BCP name)</div>
        <div style="font-size:0.7rem;color:var(--muted);text-transform:uppercase;letter-spacing:0.06em;">Canonical name</div>
        <div></div>
      </div>
      ${entries.map(([variant, canonical]) => `
        <div style="display:grid;grid-template-columns:1fr 1fr auto;gap:8px;align-items:center;padding:8px 14px;border-bottom:0.5px solid var(--border);">
          <div style="font-size:0.82rem;color:var(--muted);">${variant}</div>
          <div style="font-size:0.82rem;color:var(--text);font-weight:500;">→ ${canonical}</div>
          <button onclick="aliasRemove(${JSON.stringify(variant)})"
            style="padding:3px 8px;background:transparent;border:1px solid var(--border);border-radius:3px;color:var(--muted);font-size:0.72rem;cursor:pointer;"
            onmouseover="this.style.borderColor='var(--loss)';this.style.color='var(--loss)'"
            onmouseout="this.style.borderColor='var(--border)';this.style.color='var(--muted)'">
            Remove
          </button>
        </div>`).join('')}
    </div>`;
}

async function aliasAdd() {
  const variant   = document.getElementById('alias-variant')?.value.trim();
  const canonical = document.getElementById('alias-canonical')?.value.trim();
  const msg       = document.getElementById('alias-add-msg');

  if (!variant || !canonical) {
    msg.style.display = 'block'; msg.style.color = 'var(--loss)';
    msg.textContent = 'Both fields are required.'; return;
  }
  if (variant === canonical) {
    msg.style.display = 'block'; msg.style.color = 'var(--loss)';
    msg.textContent = 'Variant and canonical name must differ.'; return;
  }

  msg.style.display = 'block'; msg.style.color = 'var(--muted)';
  msg.textContent = 'Saving...';

  const registry = aliasGetRegistry();
  registry[variant] = canonical;

  try {
    await aliasSaveRegistry(registry);
    document.getElementById('alias-variant').value = '';
    document.getElementById('alias-canonical').value = '';
    msg.style.color = 'var(--win)';
    msg.textContent = `✓ Alias saved: "${variant}" → "${canonical}"`;
    aliasRenderList();
    setTimeout(() => { msg.style.display = 'none'; }, 3000);
  } catch(e) {
    msg.style.color = 'var(--loss)';
    msg.textContent = 'Network error -- try again.';
  }
}

async function aliasRemove(variant) {
  if (!confirm(`Remove alias for "${variant}"?`)) return;
  const registry = aliasGetRegistry();
  delete registry[variant];
  try {
    await aliasSaveRegistry(registry);
    aliasRenderList();
  } catch(e) {
    alert('Network error -- could not remove alias.');
  }
}

async function aliasRepair() {
  const msg = document.getElementById('alias-repair-msg');
  const registry = aliasGetRegistry();
  const aliases = Object.keys(registry);

  if (!aliases.length) {
    msg.style.display = 'block'; msg.style.background = 'var(--surface2)'; msg.style.color = 'var(--muted)';
    msg.textContent = 'No aliases defined -- nothing to repair.'; return;
  }

  msg.style.display = 'block'; msg.style.background = 'var(--surface2)'; msg.style.color = 'var(--muted)';
  msg.textContent = 'Scanning events...';

  try {
    const res = await fetch(`${API}/events`);
    const data = await res.json();
    const allEvents = data.events || [];

    let patchCount = 0;
    const patches = [];

    allEvents.forEach(ev => {
      (ev.results || []).forEach(r => {
        if (!r.subteam) return;
        const canonical = registry[r.subteam];
        if (canonical && canonical !== r.subteam) {
          patches.push({ resultId: r.id, subteam: canonical, currentName: r.subteam });
        }
      });
    });

    if (!patches.length) {
      msg.style.color = 'var(--win)';
      msg.textContent = '✓ No mismatches found -- all subteam names are already canonical.';
      return;
    }

    msg.textContent = `Found ${patches.length} result${patches.length > 1 ? 's' : ''} to patch -- fixing...`;

    let fixed = 0;
    for (const p of patches) {
      try {
        const patchRes = await fetch(`${API}/events`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            pin: getAdminPin(),
            resultId: p.resultId,
            updates: { subteam: p.subteam }
          })
        });
        const patchData = await patchRes.json();
        if (patchData.success) fixed++;
      } catch(e) { /* continue */ }
    }

    msg.style.background = fixed === patches.length ? 'var(--win-bg)' : 'var(--draw-bg)';
    msg.style.color = fixed === patches.length ? 'var(--win)' : 'var(--draw)';
    msg.textContent = `✓ Patched ${fixed} of ${patches.length} results. Reloading stats...`;

    await loadApprovedSubmissions();
    rebuildStats();
    await loadDbEvents();

  } catch(e) {
    msg.style.background = 'var(--loss-bg)'; msg.style.color = 'var(--loss)';
    msg.textContent = 'Network error -- try again.';
  }
}


// -- BCP Bookmarklet Import --
let _bcpParsed = null;       // { mode: 'individual'|'teams', teamStandings, individualResults, merged }

function bcpAutoSortDate(val) {
  const MONTHS = {jan:1,feb:2,mar:3,apr:4,may:5,jun:6,jul:7,aug:8,sep:9,oct:10,nov:11,dec:12};
  const s = val.trim().toLowerCase();
  const mDay = s.match(/(\d{1,2})[\s-\--]+\d{0,2}\s*([a-z]+)\s+(\d{4})/);
  if (mDay && MONTHS[mDay[2]] && parseInt(mDay[3]) > 2020) {
    const el = document.getElementById('bcp-ev-sortdate');
    if (el) el.value = parseInt(mDay[3]) * 10000 + MONTHS[mDay[2]] * 100 + parseInt(mDay[1]);
    return;
  }
  const mMon = s.match(/([a-z]+)[\s\-]+(\d{4})/);
  if (mMon && MONTHS[mMon[1]] && parseInt(mMon[2]) > 2020) {
    const el = document.getElementById('bcp-ev-sortdate');
    if (el) el.value = parseInt(mMon[2]) * 10000 + MONTHS[mMon[1]] * 100 + 1;
  }
}

function bcpDetectMode(results) {
  // Individual: player names match D.players OR factions are present
  // Teams: player names don't match D.players AND no factions (team names as "player")
  const knownPlayers = new Set(D.players.map(p => p.name));
  const hasFactions = results.some(r => r.faction && r.faction.trim());
  const anyKnown = results.some(r => knownPlayers.has(r.player));
  return (hasFactions || anyKnown) ? 'individual' : 'teams';
}

function bcpGetTeamRegistry() {
  // Get the most recent _teams_ entry from attendanceData
  const keys = Object.keys(attendanceData).filter(k => k.startsWith('_teams_'));
  if (!keys.length) return [];
  keys.sort().reverse(); // most recent first
  try { return JSON.parse(attendanceData[keys[0]]) || []; } catch(e) { return []; }
}

function bcpParsePreview() {
  const raw1 = document.getElementById('bcp-paste')?.value.trim();
  const raw2 = document.getElementById('bcp-paste2')?.value.trim();
  const meta = document.getElementById('bcp-meta');
  const modeBar = document.getElementById('bcp-mode-bar');
  const paste2Wrap = document.getElementById('bcp-paste2-wrap');

  if (!raw1 || raw1.length < 10) {
    if (meta) meta.style.display = 'none';
    if (modeBar) modeBar.style.display = 'none';
    if (paste2Wrap) paste2Wrap.style.display = 'none';
    _bcpParsed = null;
    return;
  }

  let data1;
  try { data1 = JSON.parse(raw1); } catch(e) { return; }
  if (!data1.event || !Array.isArray(data1.results) || !data1.results.length) return;

  const mode = bcpDetectMode(data1.results);

  // If PSSN teams already confirmed and paste2 just changed -- go straight to team assign
  if (mode === 'teams' && _bcpParsed?.pssnTeams?.length && raw2 && raw2.length > 10) {
    let data2;
    try { data2 = JSON.parse(raw2); } catch(e) { return; }
    if (data2?.results?.length) {
      const knownPlayers = new Set(D.players.map(p => p.name));
      const registry = bcpGetTeamRegistry();
      const playerToTeam = {};
      registry.forEach(team => { (team.players||[]).forEach(p => { playerToTeam[p] = team.name; }); });
      // For players not in registry, try to match by team name similarity from paste2
      // (BCP individual results sometimes include team context in player names on team pages)
      bcpBuildTeamAssign(data2.results, _bcpParsed.pssnTeams, _bcpParsed.teamStandings, playerToTeam, knownPlayers);
      document.getElementById('bcp-pssn-picker').style.display = 'none';
      document.getElementById('bcp-team-assign').style.display = 'block';
      document.getElementById('bcp-meta').style.display = 'none';
      const modeBar = document.getElementById('bcp-mode-bar');
      modeBar.textContent = '⬦ Assign players to teams · drag to reassign · then confirm';
      return;
    }
  }

  _bcpParsed = { mode };

  // Pre-fill event name
  document.getElementById('bcp-ev-name').value = data1.event;

  if (mode === 'individual') {
    // -- INDIVIDUAL EVENT --
    modeBar.style.display = 'block';
    modeBar.style.background = 'var(--win-bg)';
    modeBar.style.color = 'var(--win)';
    modeBar.textContent = '✓ Individual event detected -- ' + data1.results.length + ' total results';
    paste2Wrap.style.display = 'none';
    document.getElementById('bcp-ev-format').value = 'GT'; // sensible default

    const knownPlayers = new Set(D.players.map(p => p.name));
    const pssnResults = data1.results.filter(r => knownPlayers.has(r.player));
    const unmatched = data1.results.filter(r => !knownPlayers.has(r.player) && r.player);
    _bcpParsed.merged = pssnResults.map(r => ({
      player_name: r.player, faction: r.faction || '',
      place: r.placing, wins: r.w, losses: r.l, draws: r.d,
      subteam: null, shadow: false, dropped: false
    }));

    // Show unmatched warning if any PSSN members were not found in the DB
    const warnEl = document.getElementById('bcp-unmatched-warn');
    if (warnEl) {
      if (unmatched.length) {
        warnEl.style.display = 'block';
        warnEl.innerHTML = `<strong style="color:var(--warn);">⚠ ${unmatched.length} player${unmatched.length>1?'s':''} not in club roster — add via Admin → Members first:</strong><br><span style="font-size:0.75rem;color:var(--muted);">${unmatched.map(r=>r.player).join(', ')}</span>`;
      } else {
        warnEl.style.display = 'none';
      }
    }

    document.getElementById('bcp-result-count').textContent = pssnResults.length + ' of ' + data1.results.length;
    const tbody = document.getElementById('bcp-preview-body');
    tbody.innerHTML = data1.results.map(r => {
      const isPssn = knownPlayers.has(r.player);
      return `<tr style="border-bottom:0.5px solid var(--border);${isPssn?'':'opacity:0.4;'}">
        <td style="padding:5px 8px;color:var(--muted);">${r.placing}</td>
        <td style="padding:5px 8px;color:var(--text);font-weight:${isPssn?'500':'400'};">${r.player}${isPssn?'':' <span style="font-size:0.68rem;color:var(--faint);">(not PSSN)</span>'}</td>
        <td style="padding:5px 8px;color:var(--muted);font-size:0.72rem;">${r.faction||'--'}</td>
        <td style="padding:5px 8px;color:var(--muted);font-size:0.72rem;">--</td>
        <td style="padding:5px 8px;text-align:center;color:var(--win);">${r.w}</td>
        <td style="padding:5px 8px;text-align:center;color:var(--loss);">${r.l}</td>
        <td style="padding:5px 8px;text-align:center;color:var(--draw);">${r.d}</td>
      </tr>`;
    }).join('');
    meta.style.display = 'block';

  } else {
    // -- TEAMS EVENT --
    modeBar.style.display = 'block';
    modeBar.style.background = 'var(--draw-bg)';
    modeBar.style.color = 'var(--draw)';
    document.getElementById('bcp-ev-format').value = 'Teams';

    // Build team placing map from paste 1
    const teamPlacings = {};
    data1.results.forEach(r => { teamPlacings[r.player] = { place: r.placing, w: r.w, l: r.l, d: r.d }; });
    _bcpParsed.teamStandings = teamPlacings;
    _bcpParsed.allTeams = data1.results.map(r => r.player);

    modeBar.textContent = '⬦ Teams event -- ' + data1.results.length + ' teams detected · select which are PSSN below';

    // Show PSSN team picker -- all teams as clickable pills with canonical name field
    const pickerBody = document.getElementById('bcp-pssn-picker-body');
    const registry = aliasGetRegistry();
    pickerBody.innerHTML = data1.results.map(r => {
      const suggested = registry[r.player] || r.player;
      return `<div style="display:flex;align-items:center;gap:8px;width:100%;margin-bottom:6px;">
        <button data-team="${r.player.replace(/"/g,'&quot;')}" onclick="bcpTogglePssnTeam(this)"
          style="padding:6px 14px;border:1px solid var(--border);border-radius:20px;background:transparent;
                 color:var(--muted);font-family:'DM Sans',sans-serif;font-size:0.82rem;cursor:pointer;
                 white-space:nowrap;flex-shrink:0;transition:all 0.15s;" data-selected="0">
          ${r.placing}. ${r.player}
        </button>
        <input type="text" class="bcp-canonical-input" data-team="${r.player.replace(/"/g,'&quot;')}"
          value="${suggested.replace(/"/g,'&quot;')}" placeholder="Canonical team name"
          style="display:none;flex:1;padding:5px 10px;background:var(--surface2);border:1px solid var(--border);
                 border-radius:4px;color:var(--text);font-family:'DM Sans',sans-serif;font-size:0.82rem;outline:none;"/>
      </div>`;
    }).join('');
    document.getElementById('bcp-pssn-picker').style.display = 'block';
    document.getElementById('bcp-paste2-wrap').style.display = 'none';
    document.getElementById('bcp-team-assign').style.display = 'none';
    document.getElementById('bcp-meta').style.display = 'none';
  }
}

function bcpTogglePssnTeam(btn) {
  const selected = btn.dataset.selected === '1';
  btn.dataset.selected = selected ? '0' : '1';
  btn.style.background = selected ? 'transparent' : 'var(--accent)';
  btn.style.color = selected ? 'var(--muted)' : '#fff';
  btn.style.borderColor = selected ? 'var(--border)' : 'var(--accent)';
  // Show/hide canonical name input alongside the pill
  const input = btn.parentElement.querySelector('.bcp-canonical-input');
  if (input) input.style.display = selected ? 'none' : 'block';
}

function bcpConfirmPssnTeams() {
  // Collect selected teams -- pill buttons with data-selected="1"
  const selectedBtns = [...document.querySelectorAll('#bcp-pssn-picker-body [data-selected="1"]')];

  if (!selectedBtns.length) {
    alert('Please select at least one PSSN team.');
    return;
  }

  // Store selected PSSN teams using canonical name from the input (not raw BCP name)
  const teamPlacings = _bcpParsed.teamStandings;
  _bcpParsed.pssnTeams = selectedBtns.map(btn => {
    const bcpName = btn.dataset.team;
    const input = btn.parentElement.querySelector('.bcp-canonical-input');
    const canonicalName = (input?.value.trim()) || bcpName;
    return { name: canonicalName, bcpName, ...teamPlacings[bcpName] };
  });

  // Auto-save any new aliases discovered (BCP name differs from canonical)
  const newAliases = _bcpParsed.pssnTeams.filter(t => t.bcpName && t.bcpName !== t.name);
  if (newAliases.length) {
    const registry = aliasGetRegistry();
    let changed = false;
    newAliases.forEach(t => {
      if (!registry[t.bcpName]) { registry[t.bcpName] = t.name; changed = true; }
    });
    if (changed) {
      aliasSaveRegistry(registry).then(() => aliasRenderList()).catch(() => {});
    }
  }

  // Update mode bar
  const modeBar = document.getElementById('bcp-mode-bar');
  modeBar.textContent = '✓ ' + _bcpParsed.pssnTeams.length + ' PSSN team' + (_bcpParsed.pssnTeams.length>1?'s':'') + ' selected · paste individual results below';

  // Show paste 2 for individual results
  document.getElementById('bcp-pssn-picker').style.display = 'none';
  document.getElementById('bcp-paste2-wrap').style.display = 'block';
}

function bcpBuildTeamAssign(individualResults, pssnTeams, teamPlacings, playerToTeam, knownPlayers) {
  const body = document.getElementById('bcp-team-assign-body');

  // Separate PSSN players from non-PSSN, and assign initial teams from registry
  const pssnPlayers = individualResults.filter(r => knownPlayers.has(r.player));
  const teamNames = pssnTeams.map(t => t.name);

  // Group players by their registry-assigned team (or 'unassigned')
  const buckets = {};
  teamNames.forEach(n => { buckets[n] = []; });
  buckets['__unassigned__'] = [];

  pssnPlayers.forEach(r => {
    const team = playerToTeam[r.player];
    if (team && buckets[team]) buckets[team].push(r);
    else buckets['__unassigned__'].push(r);
  });

  function playerCard(r, teamName) {
    return `<div draggable="true"
      data-player="${r.player.replace(/"/g,'&quot;')}"
      data-faction="${(r.faction||'').replace(/"/g,'&quot;')}"
      data-w="${r.w}" data-l="${r.l}" data-d="${r.d}"
      ondragstart="bcpDragStart(event)"
      style="display:flex;align-items:center;justify-content:space-between;padding:6px 10px;
             background:var(--surface2);border:1px solid var(--border);border-radius:4px;
             margin-bottom:4px;cursor:grab;gap:8px;font-size:0.82rem;">
        <span style="color:var(--text);font-weight:500;">${r.player}</span>
        <span style="color:var(--muted);font-size:0.72rem;">${r.faction||'--'}</span>
        <span style="color:var(--muted);font-size:0.72rem;white-space:nowrap;">${r.w}W ${r.l}L ${r.d}D</span>
    </div>`;
  }

  function teamBucket(teamName, players) {
    const tp = teamPlacings[teamName];
    const isReal = teamName !== '__unassigned__';
    const label = isReal
      ? `${teamName} <span style="color:var(--muted);font-size:0.72rem;">· ${tp ? tp.place + (tp.place===1?'st':tp.place===2?'nd':tp.place===3?'rd':'th') + ' place' : 'not in paste 1'}</span>`
      : '<span style="color:var(--loss);">⚠ Unassigned players</span>';
    return `<div style="margin-bottom:12px;">
      <div style="font-size:0.75rem;font-weight:500;color:${isReal?'var(--text)':'var(--loss)'};margin-bottom:6px;">${label}</div>
      <div id="bcp-bucket-${teamName.replace(/[^a-z0-9]/gi,'_')}"
        ondragover="event.preventDefault()"
        ondrop="bcpDrop(event,'${teamName.replace(/'/g,'\'')}')"
        style="min-height:42px;padding:4px;background:var(--bg);border:1px dashed ${isReal?'var(--border)':'var(--loss)'};
               border-radius:4px;${players.length===0?'display:flex;align-items:center;justify-content:center;':''}">
        ${players.length ? players.map(r => playerCard(r)).join('') : '<span style="font-size:0.72rem;color:var(--faint);">Drop players here</span>'}
      </div>
    </div>`;
  }

  let html = teamNames.map(n => teamBucket(n, buckets[n])).join('');
  if (buckets['__unassigned__'].length) html += teamBucket('__unassigned__', buckets['__unassigned__']);
  body.innerHTML = html;
}

function bcpDragStart(event) {
  const el = event.currentTarget;
  event.dataTransfer.setData('text/plain', JSON.stringify({
    player: el.dataset.player,
    faction: el.dataset.faction,
    w: +el.dataset.w, l: +el.dataset.l, d: +el.dataset.d
  }));
  event.dataTransfer.effectAllowed = 'move';
  setTimeout(() => el.style.opacity = '0.4', 0);
}

function bcpDrop(event, targetTeam) {
  event.preventDefault();
  let data;
  try { data = JSON.parse(event.dataTransfer.getData('text/plain')); } catch(e) { return; }

  // Remove player from any bucket they're currently in
  document.querySelectorAll('[id^="bcp-bucket-"] [data-player]').forEach(el => {
    if (el.dataset.player === data.player) el.remove();
  });

  // Update the internal playerToTeam map
  if (_bcpParsed.playerToTeam) _bcpParsed.playerToTeam[data.player] = targetTeam;

  // Add player card to new bucket
  const bucketId = 'bcp-bucket-' + targetTeam.replace(/[^a-z0-9]/gi, '_');
  const bucket = document.getElementById(bucketId);
  if (!bucket) return;

  // Remove "drop here" placeholder if present
  const placeholder = bucket.querySelector('span');
  if (placeholder) placeholder.remove();
  bucket.style.display = '';

  const card = document.createElement('div');
  card.draggable = true;
  card.dataset.player = data.player;
  card.dataset.faction = data.faction;
  card.dataset.w = data.w;
  card.dataset.l = data.l;
  card.dataset.d = data.d;
  card.ondragstart = bcpDragStart;
  card.style.cssText = 'display:flex;align-items:center;justify-content:space-between;padding:6px 10px;background:var(--surface2);border:1px solid var(--border);border-radius:4px;margin-bottom:4px;cursor:grab;gap:8px;font-size:0.82rem;';
  card.innerHTML = `<span style="color:var(--text);font-weight:500;">${data.player}</span><span style="color:var(--muted);font-size:0.72rem;">${data.faction||'--'}</span><span style="color:var(--muted);font-size:0.72rem;white-space:nowrap;">${data.w}W ${data.l}L ${data.d}D</span>`;
  bucket.appendChild(card);
}

function bcpConfirmTeams() {
  // Read current bucket state from DOM → build merged results
  const teamPlacings = _bcpParsed.teamStandings;
  const pssnTeams = _bcpParsed.pssnTeams || [];
  const merged = [];
  const warnings = [];

  pssnTeams.forEach(team => {
    const tp = teamPlacings[team.name];
    if (!tp) { warnings.push('Team "' + team.name + '" not found in paste 1'); return; }
    const bucketId = 'bcp-bucket-' + team.name.replace(/[^a-z0-9]/gi, '_');
    const bucket = document.getElementById(bucketId);
    if (!bucket) return;
    bucket.querySelectorAll('[data-player]').forEach(el => {
      merged.push({
        player_name: el.dataset.player,
        faction: el.dataset.faction || '',
        place: tp.place,
        wins: +el.dataset.w, losses: +el.dataset.l, draws: +el.dataset.d,
        subteam: team.name, shadow: false, dropped: false
      });
    });
  });

  // Check for unassigned PSSN players
  const unassignedBucket = document.getElementById('bcp-bucket-__unassigned__');
  if (unassignedBucket) {
    unassignedBucket.querySelectorAll('[data-player]').forEach(el => {
      warnings.push(el.dataset.player + ' is unassigned -- not imported');
    });
  }

  _bcpParsed.merged = merged;
  _bcpParsed.warnings = warnings;

  // Hide team assign, show meta/preview
  document.getElementById('bcp-team-assign').style.display = 'none';
  const meta = document.getElementById('bcp-meta');

  // Populate preview table
  document.getElementById('bcp-result-count').textContent = merged.length + (warnings.length ? ' · ⚠ ' + warnings.length + ' unassigned' : '');
  const tbody = document.getElementById('bcp-preview-body');
  tbody.innerHTML = merged.map(r => `
    <tr style="border-bottom:0.5px solid var(--border);">
      <td style="padding:5px 8px;color:var(--muted);">${r.place}</td>
      <td style="padding:5px 8px;color:var(--text);font-weight:500;">${r.player_name}</td>
      <td style="padding:5px 8px;color:var(--muted);font-size:0.72rem;">${r.faction||'--'}</td>
      <td style="padding:5px 8px;color:var(--muted);font-size:0.72rem;">${r.subteam}</td>
      <td style="padding:5px 8px;text-align:center;color:var(--win);">${r.wins}</td>
      <td style="padding:5px 8px;text-align:center;color:var(--loss);">${r.losses}</td>
      <td style="padding:5px 8px;text-align:center;color:var(--draw);">${r.draws}</td>
    </tr>`).join('');

  const modeBar = document.getElementById('bcp-mode-bar');
  modeBar.textContent = '✓ Teams confirmed -- ' + merged.length + ' results ready to import' + (warnings.length ? ' · ⚠ ' + warnings.join('; ') : '');
  modeBar.style.background = warnings.length ? 'var(--draw-bg)' : 'var(--win-bg)';
  modeBar.style.color = warnings.length ? 'var(--draw)' : 'var(--win)';

  meta.style.display = 'block';
}

function bcpFindPssnTeams(teamPlacings) {
  const registry = bcpGetTeamRegistry();
  return registry.filter(t => t.name && teamPlacings[t.name]);
}

async function bcpImport() {
  const msg = document.getElementById('bcp-message');
  const name     = document.getElementById('bcp-ev-name').value.trim();
  const date     = document.getElementById('bcp-ev-date').value.trim();
  const sortDate = parseInt(document.getElementById('bcp-ev-sortdate').value);
  const format   = document.getElementById('bcp-ev-format').value;
  const players  = parseInt(document.getElementById('bcp-ev-players').value) || 0;
  const teams    = parseInt(document.getElementById('bcp-ev-teams').value) || 0;
  const bcpUrl   = document.getElementById('bcp-ev-url').value.trim();

  if (!name || !date || !sortDate || !format) {
    msg.style.display = 'block'; msg.style.background = 'var(--loss-bg)'; msg.style.color = 'var(--loss)';
    msg.textContent = 'Please fill in event name, display date, sort date and format.'; return;
  }
  if (!_bcpParsed?.merged?.length) {
    msg.style.display = 'block'; msg.style.background = 'var(--loss-bg)'; msg.style.color = 'var(--loss)';
    msg.textContent = _bcpParsed?.mode === 'teams' ? 'Paste the individual results in the second box first.' : 'No valid PSSN results to import.';
    return;
  }

  msg.style.display = 'block'; msg.style.background = 'var(--surface2)'; msg.style.color = 'var(--muted)';
  msg.textContent = 'Importing ' + _bcpParsed.merged.length + ' results...';

  const event = { name, event_date: date, sort_date: sortDate, format, total_players: players, total_teams: teams, bcp_url: bcpUrl };

  try {
    const res = await fetch(`${API}/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin: getAdminPin(), event, results: _bcpParsed.merged })
    });
    const data = await res.json();
    if (data.success) {
      msg.style.background = 'var(--win-bg)'; msg.style.color = 'var(--win)';
      msg.textContent = '✓ Imported "' + name + '" with ' + _bcpParsed.merged.length + ' results. Reloading stats...';
      await loadApprovedSubmissions();
      rebuildStats();
      buildNowPanel();
      await loadDbEvents();
      if (document.getElementById('tab-calendar')?.style.display !== 'none') renderCalendar();
      updatePendingBadge();
      setTimeout(bcpClear, 2500);
    } else {
      msg.style.background = 'var(--loss-bg)'; msg.style.color = 'var(--loss)';
      msg.textContent = 'Error: ' + (data.error || 'Unknown');
    }
  } catch(e) {
    msg.style.background = 'var(--loss-bg)'; msg.style.color = 'var(--loss)';
    msg.textContent = 'Network error -- try again.';
  }
}

function bcpClear() {
  _bcpParsed = null;
  ['bcp-paste','bcp-paste2','bcp-ev-name','bcp-ev-date','bcp-ev-sortdate','bcp-ev-players','bcp-ev-teams','bcp-ev-url']
    .forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
  ['bcp-meta','bcp-paste2-wrap','bcp-mode-bar','bcp-message','bcp-team-assign','bcp-pssn-picker'].forEach(id => {
    const el = document.getElementById(id); if (el) el.style.display = 'none';
  });
}



async function loadDbEvents() {
  try {
    const res = await fetch(`${API}/events`);
    const ct = res.headers.get('content-type') || '';
    if (!ct.includes('application/json')) return;
    const data = await res.json();
    dbEvents = data.events || [];
    filterDbEvents(); // renders with any active filters applied
  } catch(e) { console.warn('Could not load db events', e); }
}

function checkEventDuplicate(name) {
  // Update any duplicate warning element on the page (wizard or sched form)
  ['ev-duplicate-warning', 'sched-duplicate-warning'].forEach(id => {
    const warn = document.getElementById(id);
    if (!warn) return;
    if (!name.trim() || !dbEvents.length) { warn.style.display = 'none'; return; }
    const match = dbEvents.find(e => e.name.toLowerCase() === name.toLowerCase().trim());
    if (match) {
      warn.style.display = 'block';
      warn.textContent = `⚠️ "${match.name}" (${match.event_date}) already exists in the database.`;
    } else {
      warn.style.display = 'none';
    }
  });
}



function playerOptions() {
  return D.players.map(p => `<option value="${p.name}">${p.name}</option>`).join('');
}


async function deleteDbEvent(id) {
  if (!confirm('Delete this event and all its results? This cannot be undone.')) return;
  try {
    const res = await fetch(`${API}/events`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin: getAdminPin(), eventId: id })
    });
    const data = await res.json();
    if (data.success) await loadDbEvents();
  } catch(e) { console.error('Delete failed', e); }
}

function filterDbEvents() {
  const search = (document.getElementById('ev-db-search')?.value || '').toLowerCase().trim();
  const format = document.getElementById('ev-db-format')?.value || '';
  const sort = document.getElementById('ev-db-sort')?.value || 'date-desc';

  let filtered = [...dbEvents];
  if (search) filtered = filtered.filter(e => e.name.toLowerCase().includes(search));
  if (format) filtered = filtered.filter(e => e.format === format);

  if (sort === 'date-desc') filtered.sort((a, b) => (b.sort_date || 0) - (a.sort_date || 0));
  else if (sort === 'date-asc') filtered.sort((a, b) => (a.sort_date || 0) - (b.sort_date || 0));
  else if (sort === 'name') filtered.sort((a, b) => a.name.localeCompare(b.name));

  const el = document.getElementById('ev-db-list');
  if (!el) return;
  if (!filtered.length) {
    el.innerHTML = `<div style="font-size:0.85rem;color:var(--muted);">No events match the filter.</div>`;
    return;
  }
  // Temporarily swap dbEvents for render, then restore
  const original = dbEvents;
  dbEvents = filtered;
  renderDbEvents();
  dbEvents = original;
}

function filterMemberList() {
  const search = (document.getElementById('member-search')?.value || '').toLowerCase().trim();
  const rows = document.querySelectorAll('#member-list > div');
  rows.forEach(row => {
    // Use data-name attribute set on card for reliable matching
    const name = (row.dataset.name || row.querySelector('.member-name')?.textContent || '').toLowerCase();
    row.style.display = (!search || name.includes(search)) ? '' : 'none';
  });
}

function renderDbEvents() {
  const el = document.getElementById('ev-db-list');
  if (!el) return;
  if (!dbEvents.length) {
    el.innerHTML = `<div style="font-size:0.85rem;color:var(--muted);">No events in database yet.</div>`;
    return;
  }
  el.innerHTML = dbEvents.map(ev => {
    const resultCount = ev.results.length;
    const formatBadge = `<span style="font-size:0.62rem;background:var(--surface2);border:1px solid var(--border);padding:1px 6px;border-radius:3px;color:var(--muted);margin-left:6px;">${ev.format}</span>`;
    const bcpLink = ev.bcp_url
      ? `<a href="${ev.bcp_url}" target="_blank" rel="noopener" onclick="event.stopPropagation()" style="font-size:0.7rem;color:var(--accent);text-decoration:none;margin-left:8px;">BCP ↗</a>`
      : '';

    const resultRows = ev.results.length
      ? ev.results.map(r => {
          const placePct = r.place && ev.total_players ? r.place / ev.total_players : null;
          const isTop = placePct && placePct <= 0.1;
          return `
          <div style="display:grid;grid-template-columns:160px 1fr auto auto;gap:8px;align-items:center;padding:6px 0;border-bottom:1px solid rgba(255,255,255,0.04);">
            <span style="font-size:0.82rem;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${r.player_name}</span>
            <span style="font-size:0.75rem;color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${r.faction}</span>
            <div style="display:flex;align-items:center;gap:8px;white-space:nowrap;">
              <span style="font-size:0.72rem;color:${isTop ? '#ff6a00' : 'var(--muted)'};">${r.place || '?'}/${ev.format === 'Teams' ? ev.total_teams : ev.total_players}</span>
              <span style="font-size:0.72rem;color:var(--win);">${r.wins}W</span>
              <span style="font-size:0.72rem;color:var(--loss);">${r.losses}L</span>
              ${r.draws > 0 ? `<span style="font-size:0.72rem;color:var(--draw);">${r.draws}D</span>` : ''}
              ${r.dropped ? `<span style="font-size:0.62rem;color:var(--loss);border:1px solid var(--loss);border-radius:3px;padding:1px 4px;">dropped</span>` : ''}
              ${r.shadow ? `<span style="font-size:0.62rem;color:var(--accent);border:1px solid var(--accent-muted);border-radius:3px;padding:1px 4px;">shadow</span>` : ''}
            </div>
            <button onclick="openEditResult(${r.id}, '${r.player_name.replace(/'/g,"\\'")}', '${r.faction.replace(/'/g,"\\'")}', ${r.place||0}, ${r.wins}, ${r.losses}, ${r.draws}, ${r.dropped}, ${r.shadow||false})"
              style="font-size:0.65rem;padding:2px 8px;background:transparent;border:1px solid var(--border);border-radius:3px;color:var(--muted);cursor:pointer;white-space:nowrap;"
              onmouseover="this.style.borderColor='var(--accent)';this.style.color='var(--accent)'"
              onmouseout="this.style.borderColor='var(--border)';this.style.color='var(--muted)'">Edit</button>
          </div>`;
        }).join('')
      : `<div style="font-size:0.82rem;color:var(--muted);padding:8px 0;">No results recorded.</div>`;

    return `
    <div style="background:var(--surface);border:1px solid var(--border);border-radius:6px;margin-bottom:8px;overflow:hidden;">
      <!-- Header row -- click to expand -->
      <div style="padding:10px 14px;display:flex;align-items:center;justify-content:space-between;gap:12px;cursor:pointer;"
           onclick="toggleDbEventResults('dber-${ev.id}')">
        <div style="min-width:0;flex:1;">
          <div style="font-size:0.88rem;color:var(--text);display:flex;align-items:center;flex-wrap:wrap;">
            ${ev.name}${formatBadge}${bcpLink}
          </div>
          <div style="font-size:0.7rem;color:var(--muted);margin-top:3px;">
            ${ev.event_date}
            &nbsp;·&nbsp; <span style="color:var(--text);">${resultCount}</span> result${resultCount !== 1 ? 's' : ''}
            ${ev.total_players ? `&nbsp;·&nbsp; ${ev.format === 'Teams' ? ev.total_teams + ' teams' : ev.total_players + ' players'}` : ''}
          </div>
        </div>
        <div style="display:flex;gap:6px;align-items:center;flex-shrink:0;">
          <span id="dber-arr-${ev.id}" style="font-size:0.7rem;color:var(--muted);transition:transform 0.2s;">▼</span>
          <button onclick="event.stopPropagation();deleteDbEvent(${ev.id})"
            style="font-size:0.72rem;padding:4px 10px;background:transparent;border:1px solid var(--border);border-radius:3px;color:var(--muted);cursor:pointer;"
            onmouseover="this.style.borderColor='var(--loss)';this.style.color='var(--loss)'"
            onmouseout="this.style.borderColor='var(--border)';this.style.color='var(--muted)'">Delete</button>
        </div>
      </div>
      <!-- Expandable results -->
      <div id="dber-${ev.id}" style="display:none;border-top:1px solid var(--border);padding:4px 14px 10px;">
        <div style="font-size:0.62rem;font-weight:500;letter-spacing:0.1em;text-transform:uppercase;color:var(--muted);padding:8px 0 4px;display:grid;grid-template-columns:160px 1fr auto auto;gap:8px;">
          <span>Player</span><span>Faction</span><span>Place / W L D</span><span></span>
        </div>
        ${resultRows}
      </div>
    </div>`; }).join('');
}

function toggleDbEventResults(id) {
  const el = document.getElementById(id);
  if (!el) return;
  const open = el.style.display !== 'none';
  el.style.display = open ? 'none' : 'block';
  const arr = document.getElementById('dber-arr-' + id.replace('dber-',''));
  if (arr) arr.style.transform = open ? '' : 'rotate(180deg)';
}

function openEditResult(id, player, faction, place, wins, losses, draws, dropped, shadow) {
  // Create/show inline edit modal
  let modal = document.getElementById('edit-result-modal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'edit-result-modal';
    modal.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.7);z-index:9999;display:flex;align-items:center;justify-content:center;padding:16px;';
    document.body.appendChild(modal);
  }
  modal.innerHTML = `
    <div style="background:var(--bg);border:1px solid var(--border);border-radius:8px;padding:1.5rem;max-width:420px;width:100%;">
      <div style="font-size:0.7rem;color:var(--muted);text-transform:uppercase;letter-spacing:0.1em;margin-bottom:12px;">Edit Result</div>
      <div style="font-size:0.95rem;color:var(--text);margin-bottom:16px;font-weight:500;">${player}</div>
      <div style="display:grid;gap:10px;">
        <div>
          <label style="font-size:0.72rem;color:var(--muted);text-transform:uppercase;letter-spacing:0.06em;display:block;margin-bottom:4px;">Faction</label>
          <select id="er-faction" style="width:100%;padding:7px 10px;background:var(--surface2);border:1px solid var(--border);border-radius:4px;color:var(--text);font-family:'DM Sans',sans-serif;font-size:0.85rem;">
            ${['Adepta Sororitas','Adeptus Custodes','Adeptus Mechanicus','Aeldari','Astra Militarum','Black Templars','Blood Angels','Chaos Daemons','Chaos Knights','Chaos Space Marines','Dark Angels','Death Guard','Deathwatch','Drukhari',"Emperor's Children",'Genestealer Cult','Grey Knights','Imperial Knights','Leagues of Votann','Necrons','Orks','Space Marines',"T'au Empire",'Thousand Sons','Tyranids','World Eaters'].map(f => `<option value="${f}" ${f===faction?'selected':''}>${f}</option>`).join('')}
          </select>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr 1fr 1fr;gap:8px;">
          <div>
            <label style="font-size:0.72rem;color:var(--win);text-transform:uppercase;letter-spacing:0.06em;display:block;margin-bottom:4px;">Wins</label>
            <input id="er-wins" type="number" min="0" value="${wins}" style="width:100%;padding:7px 10px;background:var(--surface2);border:1px solid var(--border);border-radius:4px;color:var(--text);font-family:'DM Sans',sans-serif;font-size:0.85rem;"/>
          </div>
          <div>
            <label style="font-size:0.72rem;color:var(--loss);text-transform:uppercase;letter-spacing:0.06em;display:block;margin-bottom:4px;">Losses</label>
            <input id="er-losses" type="number" min="0" value="${losses}" style="width:100%;padding:7px 10px;background:var(--surface2);border:1px solid var(--border);border-radius:4px;color:var(--text);font-family:'DM Sans',sans-serif;font-size:0.85rem;"/>
          </div>
          <div>
            <label style="font-size:0.72rem;color:var(--draw);text-transform:uppercase;letter-spacing:0.06em;display:block;margin-bottom:4px;">Draws</label>
            <input id="er-draws" type="number" min="0" value="${draws}" style="width:100%;padding:7px 10px;background:var(--surface2);border:1px solid var(--border);border-radius:4px;color:var(--text);font-family:'DM Sans',sans-serif;font-size:0.85rem;"/>
          </div>
          <div>
            <label style="font-size:0.72rem;color:var(--muted);text-transform:uppercase;letter-spacing:0.06em;display:block;margin-bottom:4px;">Place</label>
            <input id="er-place" type="number" min="1" value="${place}" style="width:100%;padding:7px 10px;background:var(--surface2);border:1px solid var(--border);border-radius:4px;color:var(--text);font-family:'DM Sans',sans-serif;font-size:0.85rem;"/>
          </div>
        </div>
        <div style="display:flex;align-items:center;gap:16px;flex-wrap:wrap;">
          <div style="display:flex;align-items:center;gap:8px;">
            <input id="er-dropped" type="checkbox" ${dropped?'checked':''} style="width:16px;height:16px;cursor:pointer;"/>
            <label for="er-dropped" style="font-size:0.82rem;color:var(--muted);cursor:pointer;">Dropped from event</label>
          </div>
          <div style="display:flex;align-items:center;gap:8px;">
            <input id="er-shadow" type="checkbox" ${shadow?'checked':''} style="width:16px;height:16px;cursor:pointer;"/>
            <label for="er-shadow" style="font-size:0.82rem;color:var(--muted);cursor:pointer;">Shadow round</label>
          </div>
        </div>
        <div id="er-msg" style="display:none;font-size:0.78rem;padding:6px 10px;border-radius:4px;"></div>
        <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:4px;">
          <button onclick="document.getElementById('edit-result-modal').style.display='none'"
            style="padding:8px 16px;background:transparent;border:1px solid var(--border);border-radius:4px;color:var(--muted);font-family:'DM Sans',sans-serif;font-size:0.85rem;cursor:pointer;">Cancel</button>
          <button onclick="saveDbResult(${id})"
            style="padding:8px 16px;background:var(--accent);border:none;border-radius:4px;color:#fff;font-family:'DM Sans',sans-serif;font-size:0.85rem;font-weight:500;cursor:pointer;">Save Changes</button>
        </div>
      </div>
    </div>`;
  modal.style.display = 'flex';
  // Close on backdrop click
  modal.onclick = (e) => { if (e.target === modal) modal.style.display = 'none'; };
}

async function saveDbResult(id) {
  const msg = document.getElementById('er-msg');
  const updates = {
    faction: document.getElementById('er-faction').value,
    wins:    parseInt(document.getElementById('er-wins').value),
    losses:  parseInt(document.getElementById('er-losses').value),
    draws:   parseInt(document.getElementById('er-draws').value),
    place:   parseInt(document.getElementById('er-place').value),
    dropped: document.getElementById('er-dropped').checked,
      shadow:  document.getElementById('er-shadow')?.checked || false,
  };
  msg.style.display = 'block'; msg.style.background = 'var(--surface2)'; msg.style.color = 'var(--muted)';
  msg.textContent = 'Saving...';
  try {
    const res = await fetch(`${API}/events`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin: getAdminPin(), resultId: id, updates })
    });
    const data = await res.json();
    if (data.success) {
      msg.style.background = 'var(--win-bg)'; msg.style.color = 'var(--win)';
      msg.textContent = '✓ Saved -- reloading stats...';
      // Refresh events cache and re-render
      await loadApprovedSubmissions();
      rebuildStats();
      await loadDbEvents();
      setTimeout(() => { document.getElementById('edit-result-modal').style.display = 'none'; }, 800);
    } else {
      msg.style.background = 'var(--loss-bg)'; msg.style.color = 'var(--loss)';
      msg.textContent = 'Error: ' + (data.error || 'Unknown');
    }
  } catch(e) {
    msg.style.background = 'var(--loss-bg)'; msg.style.color = 'var(--loss)';
    msg.textContent = 'Network error.';
  }
}

function buildFactionStats() {
  const el = document.getElementById('faction-stats');
  if (!el) return;

  const events = getActiveEvents();

  // Build faction data from all active events
  const factions = {};
  events.forEach(ev => {
    const total = ev.format === 'Teams' ? ev.totalTeams : ev.totalPlayers;
    (ev.results || []).forEach(r => {
      if (r.dropped || !r.faction) return;
      if (!factions[r.faction]) {
        factions[r.faction] = { w:0, l:0, d:0, games:0, players:new Set(), events:new Set(), bestPlacing:null, bestTotal:null, bestEvent:null };
      }
      const s = factions[r.faction];
      const w = r.w || 0;
      const l = r.shadow ? 0 : (r.l || 0);
      const d = r.shadow ? 0 : (r.d || 0);
      s.w += w; s.l += l; s.d += d;
      s.games += w + l + d;
      s.players.add(r.player);
      s.events.add(ev.name);
      if (r.placing && (!s.bestPlacing || r.placing/total < s.bestPlacing/s.bestTotal)) {
        s.bestPlacing = r.placing;
        s.bestTotal = total;
        s.bestEvent = ev.name;
      }
    });
  });

  // Sort by Bayesian win rate (same logic as leaderboard)
  const factionList = Object.entries(factions)
    .filter(([,s]) => s.games >= 5)
    .map(([name, s]) => {
      const rawWr = s.games ? s.w / s.games : 0;
      const teamAvg = 0.58; // approximate
      const bWr = (s.games / (s.games + 10)) * rawWr + (10 / (s.games + 10)) * teamAvg;
      return { name, ...s, rawWr, bWr };
    })
    .sort((a,b) => b.bWr - a.bWr);

  // Player loyalty -- who plays each faction most
  const playerFactions = {};
  events.forEach(ev => {
    (ev.results || []).forEach(r => {
      if (r.dropped || !r.faction) return;
      if (!playerFactions[r.player]) playerFactions[r.player] = {};
      playerFactions[r.player][r.faction] = (playerFactions[r.player][r.faction] || 0) + 1;
    });
  });

  // Most played faction per player
  const loyaltyMap = {};
  Object.entries(playerFactions).forEach(([player, facs]) => {
    const top = Object.entries(facs).sort((a,b) => b[1]-a[1])[0];
    if (top) {
      if (!loyaltyMap[top[0]]) loyaltyMap[top[0]] = [];
      loyaltyMap[top[0]].push({ player, games: facs[top[0]], total: Object.values(facs).reduce((a,b)=>a+b,0) });
    }
  });

  // Max games for bar scaling
  const maxGames = Math.max(...factionList.map(f => f.games), 1);

  const rows = factionList.map((f, i) => {
    const wr = Math.round(f.rawWr * 100);
    const bwr = Math.round(f.bWr * 100);
    const wrColor = bwr >= 60 ? '#ff6a00' : bwr >= 50 ? 'var(--win)' : bwr >= 40 ? 'var(--text)' : 'var(--loss)';
    const barPct = Math.round((f.games / maxGames) * 100);
    const isTop = bwr >= 60;
    const loyal = (loyaltyMap[f.name] || []).sort((a,b) => b.games-a.games)[0];
    const bestStr = f.bestPlacing ? `${f.bestPlacing}/${f.bestTotal}` : '--';
    const cardId = `fs-${f.name.replace(/[^a-z0-9]/gi,'-').toLowerCase()}`;

    return `
      <div style="background:var(--surface);border:1px solid ${isTop?'var(--accent-muted)':'var(--border)'};border-radius:6px;padding:12px 14px;cursor:pointer;" onclick="toggleLb('${cardId}')">
        <div style="display:grid;grid-template-columns:24px 1fr 80px 70px 20px;align-items:center;gap:10px;">
          <div style="font-family:'Bebas Neue',sans-serif;font-size:1rem;color:${i<3?'var(--accent)':'var(--muted)'};">${i+1}</div>
          <div>
            <div style="font-size:0.88rem;color:var(--text);font-weight:400;">${f.name}</div>
            <div style="font-size:0.68rem;color:var(--muted);margin-top:2px;">
              ${f.players.size} player${f.players.size!==1?'s':''} · ${f.events.size} event${f.events.size!==1?'s':''}
              ${loyal ? `· <span style="color:var(--text);">${loyal.player}</span> leads` : ''}
            </div>
            <div style="margin-top:5px;height:3px;background:var(--surface2);border-radius:2px;overflow:hidden;max-width:160px;">
              <div style="width:${barPct}%;height:100%;background:${wrColor};border-radius:2px;opacity:0.7;"></div>
            </div>
          </div>
          <div style="text-align:center;">
            <div style="font-size:0.72rem;color:var(--muted);">${f.w}W ${f.l}L${f.d>0?' '+f.d+'D':''}</div>
            <div style="font-size:0.65rem;color:var(--faint);">${f.games} games</div>
          </div>
          <div style="text-align:right;">
            <div style="font-family:'Bebas Neue',sans-serif;font-size:1.3rem;color:${wrColor};">${bwr}%</div>
            <div style="font-size:0.62rem;color:var(--muted);">${wr}% raw</div>
          </div>
          <div id="${cardId}-arrow" style="color:var(--muted);font-size:0.75rem;transition:transform 0.2s;">▼</div>
        </div>
        <!-- Expanded detail -->
        <div id="${cardId}" style="display:none;margin-top:10px;padding-top:10px;border-top:1px solid var(--border);">
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;font-size:0.78rem;">
            <div>
              <div style="font-size:0.65rem;color:var(--muted);text-transform:uppercase;letter-spacing:0.08em;margin-bottom:4px;">Best Result</div>
              <div style="color:${f.bestPlacing && f.bestPlacing/f.bestTotal<=0.1?'#ff6a00':'var(--text)'};">${bestStr}${f.bestEvent?` · ${f.bestEvent.replace(' -- 40k Main Event','').replace(' Grand Tournament','')}`:''}  </div>
            </div>
            <div>
              <div style="font-size:0.65rem;color:var(--muted);text-transform:uppercase;letter-spacing:0.08em;margin-bottom:4px;">PSSN Players</div>
              <div style="color:var(--text);">${[...f.players].join(', ')}</div>
            </div>
          </div>
          ${loyal ? `
          <div style="margin-top:8px;font-size:0.78rem;">
            <div style="font-size:0.65rem;color:var(--muted);text-transform:uppercase;letter-spacing:0.08em;margin-bottom:4px;">Most Loyal</div>
            ${(loyaltyMap[f.name]||[]).sort((a,b)=>b.games-a.games).slice(0,3).map(p =>
              `<div style="display:flex;justify-content:space-between;padding:2px 0;border-bottom:1px solid var(--border);">
                <span style="color:var(--text);cursor:pointer;" onclick="event.stopPropagation();openPlayerPanel('${p.player}')" class="player-link">${p.player}</span>
                <span style="color:var(--muted);">${p.games}/${p.total} games</span>
              </div>`
            ).join('')}
          </div>` : ''}
        </div>
      </div>`;
  }).join('');

  // Summary stats at top
  const totalFactions = Object.keys(factions).length;
  const topFaction = factionList[0];
  const mostUsed = factionList.sort((a,b) => b.games-a.games)[0];
  // re-sort for display
  factionList.sort((a,b) => b.bWr-a.bWr);

  el.innerHTML = `
    <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:8px;margin-bottom:1.5rem;">
      <div style="background:var(--surface);border:1px solid var(--border);border-radius:4px;padding:10px 12px;">
        <div style="font-size:0.62rem;color:var(--muted);text-transform:uppercase;letter-spacing:0.08em;margin-bottom:4px;">Factions Played</div>
        <div style="font-family:'Bebas Neue',sans-serif;font-size:1.8rem;color:var(--text);">${totalFactions}</div>
      </div>
      <div style="background:var(--surface);border:1px solid var(--border);border-radius:4px;padding:10px 12px;">
        <div style="font-size:0.62rem;color:var(--muted);text-transform:uppercase;letter-spacing:0.08em;margin-bottom:4px;">Top Performer</div>
        <div style="font-size:0.88rem;color:var(--accent);">${topFaction?.name||'--'}</div>
        <div style="font-size:0.68rem;color:var(--muted);">${topFaction?Math.round(topFaction.bWr*100)+'% wr':''}</div>
      </div>
      <div style="background:var(--surface);border:1px solid var(--border);border-radius:4px;padding:10px 12px;">
        <div style="font-size:0.62rem;color:var(--muted);text-transform:uppercase;letter-spacing:0.08em;margin-bottom:4px;">Most Played</div>
        <div style="font-size:0.88rem;color:var(--text);">${mostUsed?.name||'--'}</div>
        <div style="font-size:0.68rem;color:var(--muted);">${mostUsed?mostUsed.games+' games':''}</div>
      </div>
    </div>
    <div style="font-size:0.68rem;color:var(--muted);margin-bottom:1rem;">Ranked by Bayesian win rate (min 5 games). Click any row to expand. Loyalty = player who plays that faction most.</div>
    <div style="display:flex;flex-direction:column;gap:8px;">
      ${rows}
    </div>
    ${Object.keys(factions).filter(f => factions[f].games < 5).length ?
      `<div style="margin-top:1rem;font-size:0.72rem;color:var(--faint);">
        ${Object.keys(factions).filter(f=>factions[f].games<5).length} factions with fewer than 5 games not shown: 
        ${Object.keys(factions).filter(f=>factions[f].games<5).join(', ')}
      </div>` : ''}`;
}

function mostPlayedFaction(name, formatFilter) {
  const counts = {};
  getActiveEvents().forEach(ev => {
    if (formatFilter === 'Singles' && ev.format === 'Teams') return;
    if (formatFilter && formatFilter !== 'Singles' && formatFilter !== 'All' && ev.format !== formatFilter) return;
    const r = ev.results.find(r => r.player === name && !r.dropped);
    if (r) counts[r.faction] = (counts[r.faction] || 0) + 1;
  });
  const sorted = Object.entries(counts).sort((a,b) => b[1] - a[1]);
  return sorted.length ? sorted[0][0] : null;
}
function getFactionWR(factionName) {
  if (!getFactionWR._cache) {
    getFactionWR._cache = {};
    const events = getActiveEvents();
    const facs = {};
    events.forEach(ev => {
      (ev.results || []).forEach(r => {
        if (r.dropped || !r.faction) return;
        if (!facs[r.faction]) facs[r.faction] = { w:0, l:0, d:0, games:0 };
        const s = facs[r.faction];
        const w = r.w||0, l = r.shadow?0:(r.l||0), d = r.shadow?0:(r.d||0);
        s.w += w; s.l += l; s.d += d; s.games += w+l+d;
      });
    });
    Object.entries(facs).forEach(([name, s]) => {
      if (s.games < 5) return;
      const raw = s.games ? s.w/s.games : 0;
      const bwr = (s.games/(s.games+10))*raw + (10/(s.games+10))*0.58;
      getFactionWR._cache[name] = Math.round(bwr*100);
    });
  }
  return getFactionWR._cache[factionName] ?? null;
}

function clearFactionWRCache() { getFactionWR._cache = null; }

function openPlayerPanel(name) {
  const panel = document.getElementById('player-panel');
  const overlay = document.getElementById('panel-overlay');
  const s = allStats[name];
  if (!s) return;

  // Load league data if not already loaded so pod context shows
  if (!leagueData) {
    loadLeagueData().then(() => { leagueLoaded = true; openPlayerPanel(name); });
    return;
  }

  const mainFaction = mostPlayedFaction(name);
  const allFactions = [...s.factions].filter(Boolean).join(' · ') || 'No faction data';
  document.getElementById('panel-name').textContent = name;
  document.getElementById('panel-factions').innerHTML = mainFaction
    ? `<span style="color:var(--accent);">${mainFaction}</span>${s.factions.size > 1 ? ` <span style="color:var(--muted);font-size:0.72rem;">· also: ${[...s.factions].filter(f => f !== mainFaction).join(', ')}</span>` : ''}`
    : allFactions;

  // Add champions rank + opt-in toggle to header
  const singlesRanked = getRanked('Singles');
  const champPos = singlesRanked.findIndex(p => p.name === name);
  const optins = getCosOptins();
  const isOptedIn = optins.has(name);
  const champRankHtml = champPos >= 0 ? `
    <div style="font-size:0.7rem;color:var(--muted);margin-top:6px;display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
      <span>#${champPos + 1} Champions of Shame${champPos < singlesRanked.filter(p => (p.events?.size||0) >= PROVISIONAL_MIN_EVENTS).length ? '' : ' <span style="color:var(--faint);">(provisional)</span>'}</span>
      <label style="display:flex;align-items:center;gap:5px;cursor:pointer;padding:2px 8px;border-radius:3px;background:${isOptedIn?'var(--accent-bg)':'var(--surface2)'};border:1px solid ${isOptedIn?'var(--accent-muted)':'var(--border)'};">
        <input type="checkbox" ${isOptedIn?'checked':''} onchange="(async()=>{await toggleCosOptin('${name.replace(/'/g,"\\'")}');openPlayerPanel('${name.replace(/'/g,"\\'")}');})()"
          style="accent-color:var(--accent);cursor:pointer;"/>
        <span style="font-size:0.68rem;color:${isOptedIn?'var(--accent)':'var(--muted)'};">${isOptedIn?'On leaderboard':'Show on leaderboard'}</span>
      </label>
    </div>` : '';
  document.getElementById('panel-factions').innerHTML += champRankHtml;

  const wr = s.games ? Math.round((s.w / s.games) * 100) : 0;
  const wrColor = wr >= 60 ? '#ff6a00' : wr >= 40 ? 'var(--text)' : 'var(--loss)';

  const fmtBreakdown = FORMATS.map(fmt => {
    const fs = fmtStats[fmt][name];
    if (!fs || !fs.games) return '';
    const fwr = Math.round((fs.w / fs.games) * 100);
    return `<div class="panel-stat">
      <div class="panel-stat-label">${fmt} win rate</div>
      <div class="panel-stat-value" style="color:${fwr >= 60 ? '#ff6a00' : fwr >= 40 ? 'var(--text)' : 'var(--loss)'}">${fwr}%</div>
      <div style="font-size:0.65rem;color:var(--muted);margin-top:2px;">${fs.w}W ${fs.l}L ${fs.d}D · ${fs.games} games</div>
    </div>`;
  }).filter(Boolean).join('');

  const playerEvents = getActiveEvents().filter(ev =>
    ev.results.some(r => r.player === name && !r.dropped)
  );

  const eventRows = playerEvents.map(ev => {
    const r = ev.results.find(r => r.player === name);
    if (!r) return '';
    const total = ev.format === 'Teams' ? ev.totalTeams : ev.totalPlayers;
    const isTop = r.placing <= Math.ceil(total * 0.1);
    const shadowTag = r.shadow ? `<span style="font-size:0.6rem;color:var(--accent);border:1px solid var(--accent-muted);padding:1px 4px;border-radius:3px;margin-left:5px;">5-0</span>` : '';
    const bcpLink = ev.bcpUrl ? `<a href="${ev.bcpUrl}" target="_blank" rel="noopener" style="color:var(--accent);font-size:0.68rem;text-decoration:none;">BCP ↗</a>` : '';
    return `
      <div class="p-event-row">
        <div style="flex:1;min-width:0;">
          <div class="p-event-name">${ev.name}${shadowTag}</div>
          <div class="p-event-meta">${ev.date} · <span class="format-pill">${ev.format}</span> · ${r.faction}${r.subteam ? ' · ' + r.subteam : ''}</div>
        </div>
        <div style="display:flex;align-items:center;gap:8px;flex-shrink:0;">
          <div style="text-align:right;">
            <div style="font-size:0.8rem;color:${isTop ? '#ff6a00' : 'var(--muted)'};">${r.placing} / ${total}</div>
            <div style="display:flex;gap:3px;margin-top:3px;">
              <span class="rec-badge rec-w">${r.w}W</span>
              <span class="rec-badge rec-l">${r.l}L</span>
              ${r.d > 0 ? `<span class="rec-badge rec-d">${r.d}D</span>` : ''}
            </div>
          </div>
          ${bcpLink}
        </div>
      </div>`;
  }).join('');

  // best result -- lowest percentile placing across all events
  const bestResult = getActiveEvents().reduce((best, ev) => {
    const r = ev.results.find(r => r.player === name);
    if (!r || r.dropped) return best;
    const total = ev.format === 'Teams' ? ev.totalTeams : ev.totalPlayers;
    const pct = r.placing / total;
    if (!best || pct < best.pct) return { pct, placing: r.placing, total, event: ev.name, date: ev.date, format: ev.format, faction: r.faction, w: r.w, l: r.l, d: r.d };
    return best;
  }, null);

  const bestResultHtml = bestResult ? `
    <div style="background:var(--accent-bg);border:1px solid var(--accent-muted);border-radius:4px;padding:10px 14px;margin-bottom:1.25rem;">
      <div style="font-size:0.65rem;font-weight:500;letter-spacing:0.1em;text-transform:uppercase;color:var(--accent);margin-bottom:6px;">Best result</div>
      <div style="font-size:0.9rem;font-weight:400;color:var(--text);">${bestResult.event}</div>
      <div style="font-size:0.75rem;color:var(--muted);margin-top:2px;">${bestResult.date} · ${bestResult.faction}</div>
      <div style="display:flex;align-items:center;gap:10px;margin-top:8px;">
        <span style="font-family:'Bebas Neue',sans-serif;font-size:1.4rem;color:var(--accent);letter-spacing:0.04em;">${bestResult.placing}<span style="font-size:0.8rem;color:var(--muted);font-family:'DM Sans',sans-serif;font-weight:300;"> / ${bestResult.total}</span></span>
        <div style="display:flex;gap:4px;">
          <span class="rec-badge rec-w">${bestResult.w}W</span>
          <span class="rec-badge rec-l">${bestResult.l}L</span>
          ${bestResult.d > 0 ? `<span class="rec-badge rec-d">${bestResult.d}D</span>` : ''}
        </div>
        <span class="format-pill">${bestResult.format}</span>
      </div>
    </div>` : '';

  // cumulative wins chart -- singles only (GT + RTT)
  const singlesEvents = getActiveEvents()
    .filter(ev => ev.format !== 'Teams')
    .filter(ev => ev.results.some(r => r.player === name && !r.dropped));

  let chartHtml = '';
  if (singlesEvents.length >= 2) {
    let cumW = 0, cumG = 0;
    const points = [{ x: 0, w: 0, g: 0, label: 'Start' }];
    singlesEvents.forEach(ev => {
      const r = ev.results.find(r => r.player === name);
      if (!r || r.dropped) return;
      const w = r.w;
      const l = r.shadow ? 0 : r.l;
      const d = r.shadow ? 0 : r.d;
      cumW += w; cumG += w + l + d;
      points.push({ x: cumG, w: cumW, label: ev.name.replace(/ -- .*/, '').replace(' Grand Tournament', ' GT').replace('London Grand Tournament - 40k Main Event', 'LGT') });
    });

    const maxG = points[points.length - 1].x;
    const maxW = Math.max(...points.map(p => p.w));
    if (maxG > 0 && maxW > 0) {
      const W = 400, H = 120, PAD = 20;
      const cx = g => PAD + (g / maxG) * (W - PAD * 2);
      const cy = w => H - PAD - (w / (maxW + 1)) * (H - PAD * 2);

      // grid lines
      let gridLines = '';
      for (let i = 0; i <= 4; i++) {
        const y = PAD + (i / 4) * (H - PAD * 2);
        gridLines += `<line x1="${PAD}" y1="${y}" x2="${W - PAD}" y2="${y}" stroke="var(--border)" stroke-width="0.5"/>`;
      }

      // path
      const pathD = points.map((p, i) =>
        `${i === 0 ? 'M' : 'L'} ${cx(p.x)} ${cy(p.w)}`
      ).join(' ');

      // fill area
      const fillD = `${pathD} L ${cx(maxG)} ${cy(0)} L ${PAD} ${cy(0)} Z`;

      // dots
      const dots = points.slice(1).map(p =>
        `<circle cx="${cx(p.x)}" cy="${cy(p.w)}" r="3" fill="var(--accent)" stroke="var(--bg)" stroke-width="1.5">
          <title>${p.label}: ${p.w} wins</title>
        </circle>`
      ).join('');

      chartHtml = `
        <div class="p-section-label" style="margin-top:1.25rem;">Cumulative wins (singles)</div>
        <div style="margin-top:8px;background:var(--surface2);border-radius:4px;padding:8px;overflow:hidden;">
          <svg viewBox="0 0 ${W} ${H}" style="width:100%;display:block;">
            ${gridLines}
            <defs>
              <linearGradient id="chartFill-${name.replace(/\s+/g,'')}" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stop-color="var(--accent)" stop-opacity="0.25"/>
                <stop offset="100%" stop-color="var(--accent)" stop-opacity="0"/>
              </linearGradient>
            </defs>
            <path d="${fillD}" fill="url(#chartFill-${name.replace(/\s+/g,'')})" />
            <path d="${pathD}" fill="none" stroke="var(--accent)" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
            ${dots}
            <text x="${PAD}" y="${H - 4}" font-size="9" fill="var(--muted)" font-family="DM Sans,sans-serif">0 games</text>
            <text x="${W - PAD}" y="${H - 4}" font-size="9" fill="var(--muted)" font-family="DM Sans,sans-serif" text-anchor="end">${maxG} games</text>
            <text x="${PAD}" y="${PAD - 4}" font-size="9" fill="var(--muted)" font-family="DM Sans,sans-serif">${maxW}W</text>
          </svg>
        </div>`;
    }
  }

  // -- badges --
  function calcBadges(playerName, playerEvs, allStats) {
    const badges = [];
    const evResults = getActiveEvents().map(ev => {
      const r = ev.results.find(r => r.player === playerName && !r.dropped);
      return r ? { ...r, format: ev.format, totalPlayers: ev.totalPlayers, totalTeams: ev.totalTeams } : null;
    }).filter(Boolean);

    // 5-0 Club -- undefeated at a GT (shadow counts)
    if (evResults.some(r => r.format === 'GT' && r.w >= 5 && (r.shadow ? 0 : r.l) === 0 && (r.shadow ? 0 : r.d) === 0))
      badges.push({ icon: '⚔️', label: '5-0 Club', desc: 'Went undefeated at a GT' });

    // Podium -- top 3 at any event
    if (evResults.some(r => r.placing <= 3))
      badges.push({ icon: '🏆', label: 'Podium', desc: 'Top 3 finish at an event' });

    // Road Warrior -- 5+ events
    if (playerEvs.length >= 5)
      badges.push({ icon: '🚗', label: 'Road Warrior', desc: `Attended ${playerEvs.length} events` });

    // Century -- 100+ games
    const totalGames = evResults.reduce((a, r) => {
      const l = r.shadow ? 0 : r.l;
      const d = r.shadow ? 0 : r.d;
      return a + r.w + l + d;
    }, 0);
    if (totalGames >= 100)
      badges.push({ icon: '💯', label: 'Century', desc: `${totalGames} games played` });

    // Collector -- 4+ factions
    const factions = new Set(evResults.map(r => r.faction));
    if (factions.size >= 4)
      badges.push({ icon: '🎨', label: 'Collector', desc: `${factions.size} factions played` });

    // Hat-trick -- 3+ wins in a row across all rounds
    const allRounds = [];
    getActiveEvents().forEach(ev => {
      const r = ev.results.find(r => r.player === playerName && !r.dropped);
      if (!r) return;
      for (let i = 0; i < r.w; i++) allRounds.push('w');
      const l = r.shadow ? 0 : r.l;
      const d = r.shadow ? 0 : r.d;
      for (let i = 0; i < l; i++) allRounds.push('l');
      for (let i = 0; i < d; i++) allRounds.push('d');
    });
    let streak = 0, maxStreak = 0;
    allRounds.forEach(r => { if (r === 'w') { streak++; maxStreak = Math.max(maxStreak, streak); } else streak = 0; });
    if (maxStreak >= 3)
      badges.push({ icon: '🔥', label: 'Hat-trick', desc: `${maxStreak} win streak` });

    // Consistent -- never below 50% at any attended event (min 3 games)
    const inconsistent = evResults.some(r => {
      const l = r.shadow ? 0 : r.l;
      const d = r.shadow ? 0 : r.d;
      const g = r.w + l + d;
      return g >= 3 && (r.w / g) < 0.5;
    });
    if (!inconsistent && evResults.length >= 3)
      badges.push({ icon: '🛡️', label: 'Consistent', desc: 'Never below 50% at any event' });

    return badges;
  }

  const playerBadges = calcBadges(name, playerEvents, allStats);
  const badgesHtml = playerBadges.length ? `
    <div class="p-section-label" style="margin-top:1rem;">Badges</div>
    <div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:8px;">
      ${playerBadges.map(b => `
        <div title="${b.desc}" style="background:var(--surface2);border:1px solid var(--border);border-radius:4px;padding:5px 10px;font-size:0.75rem;color:var(--text);display:flex;align-items:center;gap:5px;cursor:default;">
          <span>${b.icon}</span><span>${b.label}</span>
        </div>`).join('')}
    </div>` : '';

  // -- H2H tracker: infer wins/losses from relative placing at shared events --
  const h2h = {}; // { opponentName: { w, l, d, shared } }
  getActiveEvents().forEach(ev => {
    const myResult = (ev.results || []).find(r => r.player === name && !r.dropped);
    if (!myResult) return;
    (ev.results || []).forEach(r => {
      if (r.player === name || r.dropped) return;
      if (!h2h[r.player]) h2h[r.player] = { w:0, l:0, d:0, shared:0 };
      h2h[r.player].shared++;
      // Infer outcome from placing (lower = better)
      if (myResult.placing < r.placing) h2h[r.player].w++;
      else if (myResult.placing > r.placing) h2h[r.player].l++;
      else h2h[r.player].d++;
    });
  });

  // Nemesis = player with most wins over this player (min 2 shared events)
  const nemesis = Object.entries(h2h)
    .filter(([,s]) => s.shared >= 2)
    .sort((a,b) => b[1].l - a[1].l || b[1].shared - a[1].shared)[0];

  // Favourite victim = player this player beats most
  const victim = Object.entries(h2h)
    .filter(([,s]) => s.shared >= 2 && s.w > s.l)
    .sort((a,b) => (b[1].w - b[1].l) - (a[1].w - a[1].l))[0];

  // Most shared events (rival at events)
  const eventRival = Object.entries(h2h)
    .sort((a,b) => b[1].shared - a[1].shared)[0];

  // Build H2H summary cards
  const h2hEntries = Object.entries(h2h)
    .filter(([,s]) => s.shared >= 2)
    .sort((a,b) => b[1].shared - a[1].shared)
    .slice(0, 8);

  const h2hRows = h2hEntries.map(([opp, s]) => {
    const total = s.w + s.l + s.d;
    const wrPct = total ? Math.round((s.w / total) * 100) : 0;
    const wrColor = wrPct >= 60 ? 'var(--win)' : wrPct >= 40 ? 'var(--text)' : 'var(--loss)';
    return `<div style="display:flex;align-items:center;gap:10px;padding:6px 0;border-bottom:1px solid var(--faint);">
      <div style="flex:1;min-width:0;">
        <span style="font-size:0.82rem;color:var(--text);cursor:pointer;" onclick="openPlayerPanel('${opp.replace(/'/g,"\'")}')">
          ${opp}
        </span>
        <span style="font-size:0.65rem;color:var(--faint);margin-left:6px;">${s.shared} events</span>
      </div>
      <div style="display:flex;align-items:center;gap:6px;flex-shrink:0;">
        <span style="font-size:0.7rem;color:var(--muted);">${s.w}W ${s.l}L${s.d>0?' '+s.d+'D':''}</span>
        <span style="font-family:'Bebas Neue',sans-serif;font-size:1.05rem;color:${wrColor};">${wrPct}%</span>
      </div>
    </div>`;
  }).join('');

  const rivalHtml = h2hEntries.length ? `
    <div class="p-section-label" style="margin-top:1.25rem;cursor:pointer;" onclick="toggleSection('panel-h2h')" onmouseover="this.style.opacity='0.7'" onmouseout="this.style.opacity='1'">
      Head-to-head <span id="panel-h2h-arrow" style="float:right;transition:transform 0.2s;">▼</span>
    </div>
    <div id="panel-h2h" style="display:none;">
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin:8px 0;">
        ${nemesis ? `<div style="background:var(--surface2);border-radius:4px;padding:8px 12px;">
          <div style="font-size:0.62rem;color:var(--muted);text-transform:uppercase;letter-spacing:0.08em;margin-bottom:3px;">Nemesis</div>
          <div style="font-size:0.85rem;color:var(--loss);cursor:pointer;" onclick="openPlayerPanel('${nemesis[0].replace(/'/g,"\'")}')">
            ${nemesis[0]}
          </div>
          <div style="font-size:0.65rem;color:var(--muted);">${nemesis[1].w}W ${nemesis[1].l}L · ${nemesis[1].shared} events</div>
        </div>` : ''}
        ${victim ? `<div style="background:var(--surface2);border-radius:4px;padding:8px 12px;">
          <div style="font-size:0.62rem;color:var(--muted);text-transform:uppercase;letter-spacing:0.08em;margin-bottom:3px;">Favourite victim</div>
          <div style="font-size:0.85rem;color:var(--win);cursor:pointer;" onclick="openPlayerPanel('${victim[0].replace(/'/g,"\'")}')">
            ${victim[0]}
          </div>
          <div style="font-size:0.65rem;color:var(--muted);">${victim[1].w}W ${victim[1].l}L · ${victim[1].shared} events</div>
        </div>` : ''}
      </div>
      <div style="margin-top:4px;">
        ${h2hRows}
      </div>
      <div style="font-size:0.65rem;color:var(--faint);margin-top:6px;">
        Inferred from relative placing at shared events. Min 2 shared events shown.
      </div>
    </div>` : '';

  // -- attendance streak --
  const allPlayerEvents = getActiveEvents()
    .filter(ev => (ev.results||[]).some(r => r.player === name && !r.dropped))
    .sort((a,b) => (a.sortDate||0) - (b.sortDate||0));

  const totalAttended = allPlayerEvents.length;

  // Calculate current streak and longest streak using sortDates
  // A streak is consecutive events (by sortDate order across all events)
  const allEventsSorted = getActiveEvents().sort((a,b) => (a.sortDate||0) - (b.sortDate||0));
  let currentStreak = 0, longestStreak = 0, streak = 0;
  for (const ev of allEventsSorted) {
    const attended = (ev.results||[]).some(r => r.player === name && !r.dropped);
    if (attended) {
      streak++;
      if (streak > longestStreak) longestStreak = streak;
    } else {
      streak = 0;
    }
  }
  // currentStreak = streak from the end
  streak = 0;
  for (let i = allEventsSorted.length - 1; i >= 0; i--) {
    const attended = (allEventsSorted[i].results||[]).some(r => r.player === name && !r.dropped);
    if (attended) streak++;
    else break;
  }
  currentStreak = streak;

  // -- league context --
  let leagueContextHtml = '';
  if (leagueData?.pods?.length) {
    // Find which pod this player is in
    const podEntry = leagueData.players?.find(p => p.player_name === name);
    if (podEntry) {
      const pod = leagueData.pods?.find(p => p.id === podEntry.pod_id);
      const { sorted, standings, podGames, podPlayers } = calcPodStandings(
        podEntry.pod_id, leagueData.players || [], leagueData.games || []
      );

      const podPos = sorted.findIndex(p => p.name === name) + 1;
      const playerStats = standings[name] || { pts: 0, bp: 0, played: 0 };
      const totalPodPlayers = podPlayers.length;
      const qualifying = podPos <= 2;

      // League win/loss from pod games
      const leagueW = podGames.filter(g => (g.player1 === name && g.bp1 > g.bp2) || (g.player2 === name && g.bp2 > g.bp1)).length;
      const leagueL = podGames.filter(g => (g.player1 === name && g.bp1 < g.bp2) || (g.player2 === name && g.bp2 < g.bp1)).length;
      const maxGames = podPlayers.length - 1;
      const gamesLeft = maxGames - playerStats.played;

      const posColor = podPos === 1 ? '#ff6a00' : podPos === 2 ? 'var(--win)' : 'var(--muted)';
      const qualBadge = qualifying
        ? `<span style="font-size:0.62rem;padding:2px 6px;border-radius:3px;background:var(--accent-bg);color:var(--accent);border:1px solid var(--accent-muted);margin-left:6px;">Qualifying</span>`
        : '';

      leagueContextHtml = `
        <div style="background:var(--surface2);border:1px solid var(--border);border-radius:6px;padding:12px 14px;margin-bottom:1.25rem;">
          <div style="font-size:0.65rem;font-weight:500;letter-spacing:0.1em;text-transform:uppercase;color:var(--muted);margin-bottom:10px;">
            League -- ${pod?.name || 'Pod'} ${qualBadge}
          </div>
          <div style="display:grid;grid-template-columns:1fr 1fr 1fr 1fr;gap:8px;text-align:center;">
            <div>
              <div style="font-family:'Bebas Neue',sans-serif;font-size:1.8rem;color:${posColor};line-height:1;">${podPos}<span style="font-size:0.9rem;color:var(--muted);">/${totalPodPlayers}</span></div>
              <div style="font-size:0.62rem;color:var(--muted);text-transform:uppercase;letter-spacing:0.06em;margin-top:2px;">Position</div>
            </div>
            <div>
              <div style="font-family:'Bebas Neue',sans-serif;font-size:1.8rem;color:var(--text);line-height:1;">${playerStats.pts}</div>
              <div style="font-size:0.62rem;color:var(--muted);text-transform:uppercase;letter-spacing:0.06em;margin-top:2px;">Points</div>
            </div>
            <div>
              <div style="font-family:'Bebas Neue',sans-serif;font-size:1.8rem;color:var(--text);line-height:1;">${leagueW}<span style="font-size:0.9rem;color:var(--loss);">/${leagueL}</span></div>
              <div style="font-size:0.62rem;color:var(--muted);text-transform:uppercase;letter-spacing:0.06em;margin-top:2px;">W / L</div>
            </div>
            <div>
              <div style="font-family:'Bebas Neue',sans-serif;font-size:1.8rem;color:${gamesLeft > 0 ? 'var(--muted)' : 'var(--win)'};line-height:1;">${gamesLeft}</div>
              <div style="font-size:0.62rem;color:var(--muted);text-transform:uppercase;letter-spacing:0.06em;margin-top:2px;">Games left</div>
            </div>
          </div>
          ${playerStats.played > 0 ? `
          <div style="margin-top:10px;padding-top:8px;border-top:1px solid var(--border);">
            <div style="font-size:0.68rem;color:var(--muted);margin-bottom:4px;">Pod standings</div>
            ${sorted.map((p, i) => `
              <div style="display:flex;align-items:center;gap:8px;padding:2px 0;${p.name===name?'color:var(--text);font-weight:500;':'color:var(--muted);'}font-size:0.78rem;">
                <span style="min-width:16px;color:${i<2?'var(--accent)':'var(--faint)'};">${i+1}.</span>
                <span style="flex:1;${p.name===name?'color:var(--text);':'color:var(--muted);'}">${p.name}${p.name===name?' ◀':''}</span>
                <span style="font-size:0.72rem;">${p.pts}pts</span>
                <span style="font-size:0.68rem;color:var(--faint);">${p.bp}bp</span>
              </div>`).join('')}
          </div>` : ''}
        </div>`;
    }
  }

  document.getElementById('panel-body').innerHTML = `
    ${leagueContextHtml}
    ${bestResultHtml}
    <div style="font-size:0.65rem;font-weight:500;letter-spacing:0.1em;text-transform:uppercase;color:var(--muted);margin-bottom:8px;">
      ${ACTIVE_EDITION === 10 ? '10th Edition' : '11th Edition'} stats
      ${ACTIVE_EDITION === 11 && !getActiveEvents().some(ev => ev.results && ev.results.some(r => r.player === name)) 
        ? '<span style="color:var(--faint);margin-left:6px;text-transform:none;letter-spacing:0;">No results yet</span>' 
        : ''}
    </div>
    <div class="panel-stat-grid">
      <div class="panel-stat">
        <div class="panel-stat-label">Overall win rate</div>
        <div class="panel-stat-value" style="color:${wrColor}">${wr}%</div>
        <div style="font-size:0.65rem;color:var(--muted);margin-top:2px;">${s.games} games</div>
      </div>
      <div class="panel-stat">
        <div class="panel-stat-label">Total wins</div>
        <div class="panel-stat-value" style="color:var(--win)">${s.w}</div>
      </div>
      <div class="panel-stat">
        <div class="panel-stat-label">Events attended</div>
        <div class="panel-stat-value">${totalAttended}</div>
        <div style="font-size:0.65rem;color:var(--muted);margin-top:2px;">${
          ['GT','RTT','Teams'].map(fmt => {
            const n = playerEvents.filter(ev => ev.format === fmt).length;
            return n ? `${n} ${fmt}` : '';
          }).filter(Boolean).join(' · ')
        }</div>
      </div>
      <div class="panel-stat">
        <div class="panel-stat-label">Current streak</div>
        <div class="panel-stat-value" style="color:${currentStreak >= 5 ? '#ff6a00' : currentStreak >= 3 ? 'var(--win)' : 'var(--text)'}">${currentStreak}</div>
        <div style="font-size:0.65rem;color:var(--muted);margin-top:2px;">Best: ${longestStreak} event${longestStreak !== 1 ? 's' : ''}</div>
      </div>
    </div>
    ${badgesHtml}
    ${rivalHtml}
    ${fmtBreakdown ? `<div class="p-section-label">By format</div><div class="panel-stat-grid">${fmtBreakdown}</div>` : ''}
    ${(() => {
      // Build per-faction stats for this player
      const playerFacs = {};
      getActiveEvents().forEach(ev => {
        const r = ev.results.find(r => r.player === name);
        if (!r || r.dropped || !r.faction) return;
        if (!playerFacs[r.faction]) playerFacs[r.faction] = { w:0, l:0, d:0, games:0, events:0, bestPlacing:null, bestTotal:null, bestEvent:'' };
        const s = playerFacs[r.faction];
        const total = ev.format === 'Teams' ? ev.totalTeams : ev.totalPlayers;
        s.w += r.w||0; s.l += r.shadow?0:(r.l||0); s.d += r.shadow?0:(r.d||0);
        s.games += (r.w||0) + (r.shadow?0:(r.l||0)) + (r.shadow?0:(r.d||0));
        s.events++;
        if (r.placing && (!s.bestPlacing || r.placing/total < s.bestPlacing/s.bestTotal)) {
          s.bestPlacing = r.placing; s.bestTotal = total; s.bestEvent = ev.name;
        }
      });
      const facList = Object.entries(playerFacs).sort((a,b) => b[1].games - a[1].games);
      if (facList.length < 2) return ''; // only show if player used multiple factions
      const rows = facList.map(([facName, fs]) => {
        const facWr = fs.games ? Math.round((fs.w / fs.games) * 100) : 0;
        const globalWr = getFactionWR(facName);
        const diff = globalWr !== null ? facWr - globalWr : null;
        const diffHtml = diff !== null ? `<span style="font-size:0.62rem;color:${diff>0?'var(--win)':diff<0?'var(--loss)':'var(--muted)'};">${diff>0?'+':''}${diff}% vs avg</span>` : '';
        const wrColor = facWr >= 60 ? '#ff6a00' : facWr >= 50 ? 'var(--win)' : facWr >= 35 ? 'var(--text)' : 'var(--loss)';
        return `<div style="display:flex;align-items:center;gap:10px;padding:6px 0;border-bottom:1px solid var(--faint);">
          <div style="flex:1;min-width:0;">
            <div style="font-size:0.82rem;color:var(--text);">${facName}</div>
            <div style="font-size:0.65rem;color:var(--muted);margin-top:1px;">${fs.games} games · ${fs.events} event${fs.events!==1?'s':''} ${fs.bestPlacing?`· Best: ${fs.bestPlacing}/${fs.bestTotal}`:''}</div>
          </div>
          <div style="display:flex;align-items:center;gap:6px;flex-shrink:0;">
            <span style="font-size:0.68rem;color:var(--muted);">${fs.w}W ${fs.l}L${fs.d>0?' '+fs.d+'D':''}</span>
            ${diffHtml}
            <span style="font-family:'Bebas Neue',sans-serif;font-size:1.1rem;color:${wrColor};">${facWr}%</span>
          </div>
        </div>`;
      }).join('');
      return `<div class="p-section-label" style="margin-top:1.25rem;">Faction breakdown</div>
        <div style="margin-top:8px;">${rows}</div>`;
    })()}
    ${chartHtml}
    <div class="p-section-label" style="margin-top:1.25rem;cursor:pointer;" onclick="toggleSection('panel-event-history')">
      Event history <span id="panel-event-history-arrow" style="float:right;transition:transform 0.2s;transform:rotate(-90deg);">▼</span>
    </div>
    <div id="panel-event-history" style="display:none;">
      ${eventRows || '<div style="font-size:0.82rem;color:var(--muted);">No results recorded yet.</div>'}
    </div>
  `;

  panel.classList.add('open');
  overlay.classList.add('open');
  document.body.style.overflow = 'hidden';
}

function closePanel() {
  document.getElementById('player-panel').classList.remove('open');
  document.getElementById('panel-overlay').classList.remove('open');
  document.body.style.overflow = '';
}

// -- apply initial edition toggle styling --
(function() {
  const ed = ACTIVE_EDITION;
  document.getElementById('ed-10').style.background = ed === 10 ? 'var(--accent)' : 'transparent';
  document.getElementById('ed-10').style.color = ed === 10 ? '#fff' : 'var(--muted)';
  document.getElementById('ed-11').style.background = ed === 11 ? 'var(--accent)' : 'transparent';
  document.getElementById('ed-11').style.color = ed === 11 ? '#fff' : 'var(--muted)';
})();

// Restore member identity on page load
window._memberName = localStorage.getItem('pssn_member') || null;

initSite();
