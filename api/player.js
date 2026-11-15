// Vercel Serverless Function — GET /api/player?name=Pseudo&tag=1234&region=auto
// Essaie plusieurs sources dans l'ordre (PROVIDERS) : si une API est down, on passe à la suivante.
// Réponse compatible v1 (ok, rank, rr) + données étendues pour la v2 + `source` (quelle API a répondu).

const REGIONS = ["eu", "na", "ap", "kr", "latam", "br"];

const TIERS = [
  "UNRATED", "UNRATED", "UNRATED",
  "IRON 1", "IRON 2", "IRON 3",
  "BRONZE 1", "BRONZE 2", "BRONZE 3",
  "SILVER 1", "SILVER 2", "SILVER 3",
  "GOLD 1", "GOLD 2", "GOLD 3",
  "PLATINUM 1", "PLATINUM 2", "PLATINUM 3",
  "DIAMOND 1", "DIAMOND 2", "DIAMOND 3",
  "ASCENDANT 1", "ASCENDANT 2", "ASCENDANT 3",
  "IMMORTAL 1", "IMMORTAL 2", "IMMORTAL 3",
  "RADIANT"
];
const tierName = (id) => TIERS[id] || "UNRATED";

// ---------- Utilitaires ----------
class ApiError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}

async function getJson(url, headers = {}, timeoutMs = 6000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { headers, signal: ctrl.signal });
    const body = await r.json().catch(() => null);
    if (!r.ok) {
      const msg = (body && body.errors && body.errors[0] && body.errors[0].message) || `HTTP ${r.status}`;
      throw new ApiError(msg, r.status);
    }
    return body;
  } catch (e) {
    if (e.name === "AbortError") throw new ApiError("Délai dépassé", 504);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

// ---------- Source 1 : HenrikDev ----------
async function henrik({ name, tag, region }) {
  const BASE = "https://api.henrikdev.xyz/valorant";
  const key = process.env.HENRIK_API_KEY;
  const h = key ? { Authorization: key } : {};
  const n = encodeURIComponent(name), t = encodeURIComponent(tag);
  const data = async (url) => (await getJson(url, h)).data;

  if (!REGIONS.includes(region)) {
    const acc = await data(`${BASE}/v1/account/${n}/${t}`);
    region = acc && REGIONS.includes(acc.region) ? acc.region : "eu";
  }

  const [mmrRes, histRes] = await Promise.allSettled([
    data(`${BASE}/v3/mmr/${region}/pc/${n}/${t}`).catch(async () => ({
      __v2: await data(`${BASE}/v2/mmr/${region}/${n}/${t}`)
    })),
    data(`${BASE}/v1/mmr-history/${region}/${n}/${t}`)
  ]);
  if (mmrRes.status !== "fulfilled") throw mmrRes.reason;
  const m = mmrRes.value || {};

  let out;
  if (m.__v2) {
    const c = m.__v2.current_data || {};
    out = {
      tier: c.currenttier || 0, rr: c.ranking_in_tier, elo: c.elo,
      lastChange: c.mmr_change_to_last_game, leaderboard: null,
      peakTier: (m.__v2.highest_rank && m.__v2.highest_rank.tier) || 0,
      icon: (c.images && c.images.large) || ""
    };
  } else {
    const c = m.current || {};
    out = {
      tier: (c.tier && c.tier.id) || 0, rr: c.rr, elo: c.elo, lastChange: c.last_change,
      leaderboard: (c.leaderboard_placement && c.leaderboard_placement.rank) || null,
      peakTier: (m.peak && m.peak.tier && m.peak.tier.id) || 0, icon: ""
    };
  }

  out.region = region;
  out.history = histRes.status === "fulfilled" && Array.isArray(histRes.value)
    ? histRes.value.map((x) => ({
        change: x.mmr_change_to_last_game || 0,
        date: (x.date_raw || 0) * 1000,
        tier: x.currenttier || 0,
        rr: x.ranking_in_tier,
        map: (x.map && x.map.name) || ""
      }))
    : [];
  return out;
}

// ---------- Sources de secours ----------
// À compléter avec les API de secours de la v1 (server/src).
// Chaque source reçoit { name, tag, region } et doit renvoyer au minimum { tier, rr }
// (optionnel : elo, lastChange, leaderboard, peakTier, icon, region, history[]).
// Elle doit lancer une erreur si elle échoue : la suivante prend alors le relais.

const PROVIDERS = [
  { id: "henrik", fn: henrik }
  // { id: "secours-1", fn: secours1 },
];

// ---------- Handler ----------
module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  const send = (status, body) => { res.statusCode = status; res.end(JSON.stringify(body)); };

  const q = req.query || {};
  const name = String(q.name || "").trim();
  const tag = String(q.tag || "").trim().replace(/^#/, "");
  const region = String(q.region || "auto").toLowerCase();
  if (!name || !tag) return send(400, { ok: false, error: "name/tag manquant" });

  const errors = [];
  for (const p of PROVIDERS) {
    try {
      const d = await p.fn({ name, tag, region });
      if (d == null || d.tier == null) throw new ApiError("Réponse vide", 502);

      res.setHeader("Cache-Control", "s-maxage=30, stale-while-revalidate=60");
      return send(200, {
        ok: true,
        source: p.id,
        name, tag,
        region: d.region || region,
        rank: tierName(d.tier),
        tier: d.tier,
        rr: d.rr != null ? d.rr : null,
        elo: d.elo != null ? d.elo : null,
        lastChange: d.lastChange != null ? d.lastChange : null,
        leaderboard: d.leaderboard || null,
        peak: { tier: d.peakTier || 0, rank: tierName(d.peakTier || 0) },
        icon: d.icon || "",
        history: Array.isArray(d.history) ? d.history : []
      });
    } catch (e) {
      errors.push({ source: p.id, status: e.status || 0, error: e.message });
      // Joueur introuvable chez une source fiable : inutile d'essayer les autres
      if (e.status === 404 && p.id === "henrik") break;
    }
  }

  const notFound = errors.some((e) => e.status === 404);
  return send(notFound ? 404 : 502, {
    ok: false,
    error: notFound ? "Joueur introuvable" : "Toutes les API sont indisponibles",
    details: errors
  });
};
