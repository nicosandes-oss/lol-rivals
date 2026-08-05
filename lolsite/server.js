// server.js
//
// One small web server that does two jobs:
//   1. Serves the website (everything in /public)
//   2. Answers GET /api/matchup?a=Name1%23Tag1&b=Name2%23Tag2
//      by calling the real Riot API and returning shared match history
//      as JSON, going back up to LOOKBACK_DAYS days.
//
// Run locally with:  RIOT_API_KEY=RGAPI-xxxx node server.js
// On a host like Render, RIOT_API_KEY is set in their dashboard instead
// of typed on the command line — see DEPLOY.md.

const express = require("express");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;
const RIOT_API_KEY = process.env.RIOT_API_KEY;

// Valid continent routing values for Riot's match-v5 and account-v1 APIs.
// americas = NA, BR, LAN, LAS
// europe   = EUW, EUNE, TR, RU
// asia     = KR, JP
// sea      = OCE (OC1), and Southeast Asian servers
const VALID_CONTINENTS = new Set(["americas", "europe", "asia", "sea"]);
const DEFAULT_CONTINENT = process.env.RIOT_CONTINENT || "americas";

// How far back to search for shared matches. match-v5's startTime/endTime
// filter lets us ask for a real date range instead of guessing how many
// games covers "2 months" — a person who plays daily needs way more than
// 50 games to cover 2 months, a person who plays rarely needs way fewer.
const LOOKBACK_DAYS = parseInt(process.env.LOOKBACK_DAYS || "60", 10);

// Safety ceiling so one lookup can't run away and chew through the whole
// rate-limit budget if two players share an unusually large number of games.
const MAX_SHARED_MATCHES_TO_FETCH = 60;

// ---------------------------------------------------------------------------
// Search history (autocomplete suggestions)
// ---------------------------------------------------------------------------
// Lives in memory only — NOT written to disk. Render's free tier wipes the
// filesystem on every restart/redeploy anyway, so a JSON file would just
// reset unpredictably and feel broken. An in-memory list that grows while
// the server is running, and starts fresh after a deploy, is the honest
// version of this feature without adding a real database.
const searchHistory = new Set(); // stores "Name#Tag" strings, most-recent-first ordering kept separately
const searchHistoryOrder = []; // array, newest first
const MAX_HISTORY_SIZE = 500;

function recordSearchedName(riotId) {
  const normalized = riotId.trim();
  if (!normalized.includes("#")) return;
  if (searchHistory.has(normalized)) {
    // Move to front (most recently used) without duplicating.
    const idx = searchHistoryOrder.indexOf(normalized);
    if (idx > -1) searchHistoryOrder.splice(idx, 1);
  } else {
    searchHistory.add(normalized);
  }
  searchHistoryOrder.unshift(normalized);
  if (searchHistoryOrder.length > MAX_HISTORY_SIZE) {
    const removed = searchHistoryOrder.pop();
    searchHistory.delete(removed);
  }
}

app.use(express.static(path.join(__dirname, "public")));

// ---------------------------------------------------------------------------
// Riot API helpers
// ---------------------------------------------------------------------------

async function riotFetch(url) {
  const res = await fetch(url, { headers: { "X-Riot-Token": RIOT_API_KEY } });

  if (res.status === 429) {
    const retryAfter = parseInt(res.headers.get("retry-after") || "1", 10);
    await new Promise((r) => setTimeout(r, retryAfter * 1000));
    return riotFetch(url);
  }

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    const err = new Error(`Riot API error ${res.status}: ${body}`);
    err.status = res.status;
    throw err;
  }

  return res.json();
}

async function getPuuid(riotId, continent) {
  const [gameName, tagLine] = riotId.split("#");
  if (!gameName || !tagLine) {
    const err = new Error(`"${riotId}" isn't a valid Riot ID. Use the format Name#Tag.`);
    err.status = 400;
    throw err;
  }
  const url = `https://${continent}.api.riotgames.com/riot/account/v1/accounts/by-riot-id/${encodeURIComponent(gameName)}/${encodeURIComponent(tagLine)}`;
  const data = await riotFetch(url);
  return data.puuid;
}

// Fetches ALL match IDs within the lookback window, paginating in batches
// of 100 (match-v5's max per call) until Riot returns an empty page.
async function getMatchIdsInWindow(puuid, lookbackDays, continent) {
  const startTime = Math.floor((Date.now() - lookbackDays * 86400000) / 1000);
  const allIds = [];
  let start = 0;
  const pageSize = 100;

  while (true) {
    const url =
      `https://${continent}.api.riotgames.com/lol/match/v5/matches/by-puuid/${puuid}/ids` +
      `?startTime=${startTime}&start=${start}&count=${pageSize}`;
    const page = await riotFetch(url);
    allIds.push(...page);

    if (page.length < pageSize) break;
    start += pageSize;
    if (start > 1000) break;
  }

  return allIds;
}

// Matches are immutable once the game is over, so caching them by ID is
// always safe — no expiry needed. This also means repeated or overlapping
// lookups (e.g. two players who share matches) skip the network entirely
// on the second hit. Lives in memory only, same tradeoff as searchHistory
// above: resets on redeploy, which is fine since it's just a speed boost.
const matchCache = new Map(); // matchId -> match data
const MAX_MATCH_CACHE_SIZE = 5000;

async function getMatch(matchId, continent) {
  const cached = matchCache.get(matchId);
  if (cached) return cached;

  const url = `https://${continent}.api.riotgames.com/lol/match/v5/matches/${matchId}`;
  const data = await riotFetch(url);

  if (matchCache.size >= MAX_MATCH_CACHE_SIZE) {
    matchCache.delete(matchCache.keys().next().value); // drop oldest entry
  }
  matchCache.set(matchId, data);

  return data;
}

// How many matches to fetch at once. Riot's personal API key allows 20
// requests/second — 10 concurrent leaves headroom for the account/match-ids
// calls happening around it, while still being ~10x faster wall-clock than
// fetching one at a time.
const MATCH_FETCH_CONCURRENCY = 10;

// Fetches a list of match IDs in parallel batches (instead of one at a time)
// and calls onMatch(matchData, matchId) for each as it resolves. Order of
// onMatch calls is not guaranteed to match matchIds order — callers that
// need original order should sort afterward (e.g. by gameCreation).
async function getMatchesBatched(matchIds, continent, onMatch) {
  for (let i = 0; i < matchIds.length; i += MATCH_FETCH_CONCURRENCY) {
    const batch = matchIds.slice(i, i + MATCH_FETCH_CONCURRENCY);
    const results = await Promise.all(
      batch.map((matchId) => getMatch(matchId, continent).then((data) => ({ matchId, data })))
    );
    for (const { matchId, data } of results) {
      onMatch(data, matchId);
    }
  }
}

// ---------------------------------------------------------------------------
// Item name -> item ID lookup, via Data Dragon (Riot's static data CDN)
// ---------------------------------------------------------------------------
// Item IDs are stable across patches, but resolving them by NAME instead of
// hardcoding numbers means this keeps working if an item ever gets a new ID
// (happens occasionally on reworks) without needing a code change — just
// restart the server and it re-fetches the current patch's item list.
//
// To add/remove items from either bucket, only edit the two name lists below.
// Names must match Data Dragon's item.json exactly (check
// https://ddragon.leagueoflegends.com/cdn/<version>/data/en_US/item.json).
const LETHALITY_ITEM_NAMES = [
  "Youmuu's Ghostblade",
  "Duskblade of Draktharr",
  "Prowler's Claw",
  "Edge of Night",
  "Serylda's Grudge",
  "Umbral Glaive",
  "Serpent's Fang",
  "Hubris",
  "Opportunity",
  "Eclipse",
];

const AD_HP_ITEM_NAMES = [
  "Trinity Force",
  "Sterak's Gage",
  "Stridebreaker",
  "Black Cleaver",
  "Sundered Sky",
  "Dead Man's Plate",
  "Heartsteel",
  "Death's Dance",
];

let itemNameToIdCache = null; // { "Youmuu's Ghostblade": 3142, ... }

async function getItemNameToIdMap() {
  if (itemNameToIdCache) return itemNameToIdCache;

  const versionsRes = await fetch("https://ddragon.leagueoflegends.com/api/versions.json");
  const versions = await versionsRes.json();
  const latest = versions[0];

  const itemsRes = await fetch(`https://ddragon.leagueoflegends.com/cdn/${latest}/data/en_US/item.json`);
  const itemsData = await itemsRes.json();

  const map = {};
  for (const [id, data] of Object.entries(itemsData.data)) {
    map[data.name] = parseInt(id, 10);
  }
  itemNameToIdCache = map;
  return map;
}

// How many items from a bucket a single player (mid or jungle) needs on
// their own to count as "building" that style. 1 is enough to mean "picked
// this up" — each role is checked independently, not summed with the other.
const BUILD_CLASSIFICATION_THRESHOLD = 1;

// Looks at a team's mid + jungle players individually (item0-item5 each;
// item6 is the trinket, skipped). Returns { hasLethality, hasBruiser } —
// true if EITHER player on their own hit the threshold for that bucket.
// The two flags aren't mutually exclusive: a team can show both if, say,
// jungle went lethality and mid went bruiser.
function classifyTeamBuild(teamParticipants, lethalityIds, adHpIds) {
  const relevant = teamParticipants.filter(
    (p) => p.teamPosition === "MIDDLE" || p.teamPosition === "JUNGLE" || p.summoner1Id === SMITE_SPELL_ID || p.summoner2Id === SMITE_SPELL_ID
  );

  let hasLethality = false;
  let hasBruiser = false;

  for (const p of relevant) {
    const items = [p.item0, p.item1, p.item2, p.item3, p.item4, p.item5];
    let playerLethalityCount = 0;
    let playerAdHpCount = 0;
    for (const itemId of items) {
      if (lethalityIds.has(itemId)) playerLethalityCount++;
      if (adHpIds.has(itemId)) playerAdHpCount++;
    }
    if (playerLethalityCount >= BUILD_CLASSIFICATION_THRESHOLD) hasLethality = true;
    if (playerAdHpCount >= BUILD_CLASSIFICATION_THRESHOLD) hasBruiser = true;
  }

  return { hasLethality, hasBruiser };
}

// Smite's summonerId in Riot's API. This is one of the oldest, most stable
// numeric IDs in the whole API (predates match-v5 itself) — equipping it
// is a more reliable jungle signal than teamPosition/individualPosition,
// which Riot's own classifier sometimes gets wrong in ARAM, customs, or
// odd lane setups. Only junglers take Smite, full stop.
const SMITE_SPELL_ID = 11;

// Pulls the rich per-player breakdown used by the expandable match detail
// view: champion, KDA, CS, damage, gold, wards, and full item list.
function statsFor(p) {
  return {
    champion: p.championName,
    win: p.win,
    k: p.kills,
    d: p.deaths,
    a: p.assists,
    cs: p.totalMinionsKilled + p.neutralMinionsKilled,
    damageDealt: p.totalDamageDealtToChampions,
    damageTaken: p.totalDamageTaken,
    goldEarned: p.goldEarned,
    visionScore: p.visionScore,
    wardsPlaced: p.wardsPlaced,
    position: p.teamPosition || p.individualPosition || null,
    isJungle: p.summoner1Id === SMITE_SPELL_ID || p.summoner2Id === SMITE_SPELL_ID,
    summonerLevel: p.summonerLevel,
    items: [p.item0, p.item1, p.item2, p.item3, p.item4, p.item5].filter((i) => i && i !== 0),
    trinket: p.item6 && p.item6 !== 0 ? p.item6 : null,
    summoner1Id: p.summoner1Id,
    summoner2Id: p.summoner2Id,
  };
}

function extractHeadToHead(matchData, puuidA, puuidB) {
  const { info } = matchData;
  const pA = info.participants.find((p) => p.puuid === puuidA);
  const pB = info.participants.find((p) => p.puuid === puuidB);
  if (!pA || !pB) return null;

  const a = statsFor(pA);
  const b = statsFor(pB);

  return {
    matchId: matchData.metadata.matchId,
    gameCreation: info.gameCreation,
    durationMin: Math.round(info.gameDuration / 60),
    queueId: info.queueId,
    gameMode: info.gameMode,
    sameTeam: pA.teamId === pB.teamId,
    bothJungle: a.isJungle && b.isJungle,
    objectives: {
      a: teamObjectivesFor(info.teams, pA.teamId),
      b: teamObjectivesFor(info.teams, pB.teamId),
    },
    a,
    b,
  };
}

// Pulls dragon/baron/grub kill counts for whichever team a given player
// was on. Dragon and Baron are long-stable fields on every match.
// Voidgrubs are newer (added patch 14.1) — Riot's internal field name for
// this camp has historically been "horde" in match data, but since this is
// a newer objective we read it defensively and simply omit it from the
// response if the field isn't present, rather than risk showing a broken
// "undefined" stat on the page.
function teamObjectivesFor(teams, teamId) {
  const team = teams.find((t) => t.teamId === teamId);
  if (!team || !team.objectives) return { dragons: 0, barons: 0, grubs: null };

  const obj = team.objectives;
  const grubsField = obj.horde || obj.voidgrub || obj.hordeKills;

  return {
    dragons: obj.dragon ? obj.dragon.kills : 0,
    barons: obj.baron ? obj.baron.kills : 0,
    grubs: grubsField ? grubsField.kills : null, // null = field not present in this match's data
  };
}

// ---------------------------------------------------------------------------
// Autocomplete suggestions, built from past successful searches
// ---------------------------------------------------------------------------
app.get("/api/suggest", (req, res) => {
  const q = (req.query.q || "").trim().toLowerCase();
  if (!q) {
    // No query yet — return the most recent searches as a starting point.
    return res.json({ suggestions: searchHistoryOrder.slice(0, 8) });
  }
  const matches = searchHistoryOrder
    .filter((name) => name.toLowerCase().includes(q))
    .slice(0, 8);
  res.json({ suggestions: matches });
});

// ---------------------------------------------------------------------------
// The API route the website calls
// ---------------------------------------------------------------------------

app.get("/api/matchup", async (req, res) => {
  const riotIdA = req.query.a;
  const riotIdB = req.query.b;
  const jungleOnly = req.query.jungleOnly === "true";
  const continent = VALID_CONTINENTS.has(req.query.region) ? req.query.region : DEFAULT_CONTINENT;
  console.log(`[matchup] region param: ${req.query.region} → continent: ${continent}`);

  if (!RIOT_API_KEY) {
    return res.status(500).json({ error: "Server is missing RIOT_API_KEY. Set it in your host's environment variables." });
  }
  if (!riotIdA || !riotIdB) {
    return res.status(400).json({ error: "Provide both ?a=Name#Tag and ?b=Name#Tag" });
  }

  try {
    const [puuidA, puuidB] = await Promise.all([getPuuid(riotIdA, continent), getPuuid(riotIdB, continent)]);

    const [idsA, idsB] = await Promise.all([
      getMatchIdsInWindow(puuidA, LOOKBACK_DAYS, continent),
      getMatchIdsInWindow(puuidB, LOOKBACK_DAYS, continent),
    ]);

    const setB = new Set(idsB);
    let sharedIds = idsA.filter((id) => setB.has(id));
    const totalSharedFound = sharedIds.length;
    const truncated = sharedIds.length > MAX_SHARED_MATCHES_TO_FETCH;
    sharedIds = sharedIds.slice(0, MAX_SHARED_MATCHES_TO_FETCH);

    let matches = [];
    await getMatchesBatched(sharedIds, continent, (matchData) => {
      const h2h = extractHeadToHead(matchData, puuidA, puuidB);
      if (h2h) matches.push(h2h);
    });

    matches.sort((m1, m2) => m2.gameCreation - m1.gameCreation);

    // Remember these names for autocomplete — only on success, so typos
    // and players who don't exist never pollute the suggestion list.
    recordSearchedName(riotIdA);
    recordSearchedName(riotIdB);

    // Fetched count is the same regardless of filter — keep this for an
    // honest "X of Y total shared games were jungle vs jungle" message.
    const jungleMatchCount = matches.filter((m) => m.bothJungle).length;

    if (jungleOnly) {
      matches = matches.filter((m) => m.bothJungle);
    }

    const enemyGames = matches.filter((m) => !m.sameTeam);
    const record = {
      aWins: enemyGames.filter((m) => m.a.win).length,
      bWins: enemyGames.filter((m) => m.b.win).length,
      allyGames: matches.length - enemyGames.length,
    };

    res.json({
      riotIdA,
      riotIdB,
      matches,
      record,
      lookbackDays: LOOKBACK_DAYS,
      truncated,
      jungleOnly,
      jungleMatchCount,
      totalFetchedCount: sharedIds.length,
      totalSharedFound,
      region: continent,
    });
  } catch (err) {
    console.error(err);
    res.status(err.status || 500).json({ error: err.message || "Something went wrong." });
  }
});

// ---------------------------------------------------------------------------
// Single-player win/loss split by whether a specific champion was an ally
// or an enemy in the match
// ---------------------------------------------------------------------------
// GET /api/champion-stats?name=Name#Tag&champion=ChampionInternalName
//
// Champion must be the exact Data Dragon internal key (e.g. "Khazix", not
// "Kha'Zix") — the frontend's autocomplete dropdown is what guarantees this,
// since it's populated straight from Data Dragon's own champion list.
//
// For each of the player's recent matches, we look at all 10 participants
// to find that champion, then bucket the game as:
//   - "with"    — the champion was on the player's own team (an ally)
//   - "against" — the champion was on the enemy team
//   - skipped   — the player themselves was the one playing that champion,
//                 or the champion didn't appear in the match at all
app.get("/api/champion-stats", async (req, res) => {
  const riotId = req.query.name;
  const champion = req.query.champion;
  const continent = VALID_CONTINENTS.has(req.query.region) ? req.query.region : DEFAULT_CONTINENT;

  if (!RIOT_API_KEY) {
    return res.status(500).json({ error: "Server is missing RIOT_API_KEY. Set it in your host's environment variables." });
  }
  if (!riotId || !champion) {
    return res.status(400).json({ error: "Provide both ?name=Name#Tag and ?champion=ChampionName" });
  }

  try {
    const puuid = await getPuuid(riotId, continent);
    const matchIds = await getMatchIdsInWindow(puuid, LOOKBACK_DAYS, continent);
    const capped = matchIds.slice(0, MAX_SHARED_MATCHES_TO_FETCH);
    const truncated = matchIds.length > MAX_SHARED_MATCHES_TO_FETCH;

    const withTeam = { wins: 0, losses: 0 };
    const against = { wins: 0, losses: 0 };

    await getMatchesBatched(capped, continent, (matchData) => {
      const self = matchData.info.participants.find((pp) => pp.puuid === puuid);
      if (!self) return;

      // Self played this champion — excluded from both buckets per the
      // feature's definition (this stat is about facing/playing alongside
      // the champion, not piloting it themselves).
      if (self.championName === champion) return;

      const champPlayer = matchData.info.participants.find((pp) => pp.championName === champion);
      if (!champPlayer) return; // champion wasn't in this match at all

      const isAlly = champPlayer.teamId === self.teamId;
      const bucket = isAlly ? withTeam : against;
      if (self.win) bucket.wins++; else bucket.losses++;
    });

    recordSearchedName(riotId);

    res.json({
      riotId,
      champion,
      withTeam,
      against,
      lookbackDays: LOOKBACK_DAYS,
      truncated,
      totalMatchesChecked: capped.length,
    });
  } catch (err) {
    console.error(err);
    res.status(err.status || 500).json({ error: err.message || "Something went wrong." });
  }
});

// ---------------------------------------------------------------------------
// Single-player win/loss split by lethality-vs-AD+HP team build matchup
// ---------------------------------------------------------------------------
// GET /api/build-stats?name=Name#Tag
//
// For each match, mid+jungle on each team are checked against the lethality
// and AD+HP item lists (see LETHALITY_ITEM_NAMES / AD_HP_ITEM_NAMES above).
// A team only counts as "lethality" or "adHp" if it clearly committed to one
// (BUILD_CLASSIFICATION_THRESHOLD) — mixed or unclear builds are skipped.
//
// Two buckets returned:
//   - lethalityAlly  — player's team went lethality, enemy went AD+HP
//   - adHpAlly       — player's team went AD+HP, enemy went lethality
// Matches where either team didn't clearly commit, or where both teams
// went the same way, are skipped (not counted in either bucket).
app.get("/api/build-stats", async (req, res) => {
  const riotId = req.query.name;
  const continent = VALID_CONTINENTS.has(req.query.region) ? req.query.region : DEFAULT_CONTINENT;

  if (!RIOT_API_KEY) {
    return res.status(500).json({ error: "Server is missing RIOT_API_KEY. Set it in your host's environment variables." });
  }
  if (!riotId) {
    return res.status(400).json({ error: "Provide ?name=Name#Tag" });
  }

  try {
    const itemNameToId = await getItemNameToIdMap();
    const lethalityIds = new Set(LETHALITY_ITEM_NAMES.map((n) => itemNameToId[n]).filter(Boolean));
    const adHpIds = new Set(AD_HP_ITEM_NAMES.map((n) => itemNameToId[n]).filter(Boolean));

    // Sanity check: if a name in either list doesn't exactly match Data
    // Dragon's current item.json (renamed/reworked item, typo, etc.), it
    // silently resolves to nothing and that item can never be detected.
    // Surfacing this in the response makes that failure visible instead of
    // looking identical to "this matchup is just rare."
    const unresolvedLethality = LETHALITY_ITEM_NAMES.filter((n) => !itemNameToId[n]);
    const unresolvedAdHp = AD_HP_ITEM_NAMES.filter((n) => !itemNameToId[n]);
    if (unresolvedLethality.length || unresolvedAdHp.length) {
      console.warn("[build-stats] Item names not found in Data Dragon:", { unresolvedLethality, unresolvedAdHp });
    }

    const puuid = await getPuuid(riotId, continent);
    const matchIds = await getMatchIdsInWindow(puuid, LOOKBACK_DAYS, continent);
    const capped = matchIds.slice(0, MAX_SHARED_MATCHES_TO_FETCH);
    const truncated = matchIds.length > MAX_SHARED_MATCHES_TO_FETCH;

    const lethalityAlly = { wins: 0, losses: 0 };
    const adHpAlly = { wins: 0, losses: 0 };
    let skipped = 0;
    let nonClassicSkipped = 0;
    let anyLethalityCount = 0; // games where SOMEONE's mid/jg went lethality (either side)
    let anyBruiserCount = 0;   // games where SOMEONE's mid/jg went bruiser (either side)
    const debugSample = []; // raw detection detail for the first few games, for troubleshooting

    // Reverse lookup (id -> name) purely for readable debug output below.
    const idToItemName = {};
    for (const [name, id] of Object.entries(itemNameToId)) idToItemName[id] = name;

    // Only Summoner's Rift queues actually have a real mid/jungle split
    // (ARAM has no Smite and blank teamPosition, Arena has no roles at all,
    // etc.) — including those would silently skip every single one of them.
    // 400 = Normal Draft, 420 = Ranked Solo/Duo, 430 = Normal Blind, 440 = Ranked Flex, 490 = Normal (Quickplay)
    const CLASSIC_SR_QUEUE_IDS = new Set([400, 420, 430, 440, 490]);

    await getMatchesBatched(capped, continent, (matchData, matchId) => {
      if (!CLASSIC_SR_QUEUE_IDS.has(matchData.info.queueId)) { nonClassicSkipped++; return; }

      const self = matchData.info.participants.find((pp) => pp.puuid === puuid);
      if (!self) { skipped++; return; }

      const ownTeam = matchData.info.participants.filter((pp) => pp.teamId === self.teamId);
      const enemyTeam = matchData.info.participants.filter((pp) => pp.teamId !== self.teamId);

      const ownBuild = classifyTeamBuild(ownTeam, lethalityIds, adHpIds);
      const enemyBuild = classifyTeamBuild(enemyTeam, lethalityIds, adHpIds);

      if (debugSample.length < 3) {
        const describe = (team) =>
          team
            .filter((p) => p.teamPosition === "MIDDLE" || p.teamPosition === "JUNGLE" || p.summoner1Id === SMITE_SPELL_ID || p.summoner2Id === SMITE_SPELL_ID)
            .map((p) => ({
              champion: p.championName,
              teamPosition: p.teamPosition,
              hasSmite: p.summoner1Id === SMITE_SPELL_ID || p.summoner2Id === SMITE_SPELL_ID,
              items: [p.item0, p.item1, p.item2, p.item3, p.item4, p.item5].filter(Boolean).map((id) => idToItemName[id] || id),
            }));
        debugSample.push({
          matchId,
          queueId: matchData.info.queueId,
          gameCreation: matchData.info.gameCreation,
          own: describe(ownTeam),
          enemy: describe(enemyTeam),
          ownBuild,
          enemyBuild,
        });
      }

      if (ownBuild.hasLethality || enemyBuild.hasLethality) anyLethalityCount++;
      if (ownBuild.hasBruiser || enemyBuild.hasBruiser) anyBruiserCount++;

      let counted = false;

      // Own team showed lethality (mid or jg), enemy team showed bruiser (mid or jg).
      if (ownBuild.hasLethality && enemyBuild.hasBruiser) {
        if (self.win) lethalityAlly.wins++; else lethalityAlly.losses++;
        counted = true;
      }
      // The reverse: own team showed bruiser, enemy team showed lethality.
      if (ownBuild.hasBruiser && enemyBuild.hasLethality) {
        if (self.win) adHpAlly.wins++; else adHpAlly.losses++;
        counted = true;
      }

      if (!counted) skipped++;
    });

    recordSearchedName(riotId);

    res.json({
      riotId,
      lethalityAlly,
      adHpAlly,
      lookbackDays: LOOKBACK_DAYS,
      truncated,
      totalMatchesChecked: capped.length,
      skipped,
      nonClassicSkipped,
      itemsResolved: { lethality: lethalityIds.size, adHp: adHpIds.size },
      anyLethalityCount,
      anyBruiserCount,
      debugSample,
    });
  } catch (err) {
    console.error(err);
    res.status(err.status || 500).json({ error: err.message || "Something went wrong." });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
