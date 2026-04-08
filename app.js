/**
 * Song ranker: merge-sort pairwise comparisons + Spotify Web API (PKCE).
 */

const REDIRECT_PATH = "callback.html";
const AUTH_SCOPES = [
  "playlist-read-private",
  "playlist-read-collaborative",
].join(" ");

const LS_CLIENT = "song_ranker_spotify_client_id";
const LS_SAVED_RANKINGS = "song_ranker_saved_rankings";
const LS_PROGRESS_AUTOSAVE = "song_ranker_progress_autosave";
const LS_PROGRESS_NAMED = "song_ranker_progress_named";
const LS_THEME = "song_ranker_theme";
const SS_VERIFIER = "song_ranker_pkce_verifier";
const SS_TOKEN = "song_ranker_access_token";
const SS_EXPIRES = "song_ranker_token_expires_at";

/** Spotify artist preset id when user picked Quick start (not started until Start ranking). */
let selectedPresetId = null;

function basePath() {
  const p = window.location.pathname;
  if (p.endsWith("/")) return p;
  return p.replace(/\/[^/]+$/, "/") || "/";
}

function redirectUri() {
  if (window.location.protocol === "file:" || !window.location.host) {
    return `http://127.0.0.1:8765/${REDIRECT_PATH}`;
  }
  const origin = `${window.location.protocol}//${window.location.host}`;
  return `${origin}${basePath()}${REDIRECT_PATH}`;
}

function setRedirectDisplay() {
  const el = document.getElementById("redirect-uri-display");
  if (el) el.textContent = redirectUri();
}

function base64urlEncode(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function sha256(plain) {
  const data = new TextEncoder().encode(plain);
  return crypto.subtle.digest("SHA-256", data);
}

async function generatePkce() {
  const verifier = base64urlEncode(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = base64urlEncode(await sha256(verifier));
  return { verifier, challenge };
}

function getStoredClientId() {
  return localStorage.getItem(LS_CLIENT) || "";
}

/** Saved ID overrides config (handy for testing); otherwise use baked-in Client ID for hosted builds. */
function getEffectiveClientId() {
  const saved = (getStoredClientId() || "").trim();
  const baked = (typeof window.SONG_RANKER_CLIENT_ID === "string" ? window.SONG_RANKER_CLIENT_ID : "").trim();
  return saved || baked;
}

function setStoredClientId(id) {
  if (id) localStorage.setItem(LS_CLIENT, id.trim());
  else localStorage.removeItem(LS_CLIENT);
}

function getAccessToken() {
  const t = sessionStorage.getItem(SS_TOKEN);
  const exp = Number(sessionStorage.getItem(SS_EXPIRES) || 0);
  if (!t || Date.now() > exp - 60_000) return null;
  return t;
}

function setAccessToken(token, expiresInSec) {
  sessionStorage.setItem(SS_TOKEN, token);
  sessionStorage.setItem(SS_EXPIRES, String(Date.now() + expiresInSec * 1000));
}

function tokenHasPlaylistReadScope(token) {
  if (!token) return false;
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return true;
    const json = JSON.parse(atob(parts[1].replace(/-/g, "+").replace(/_/g, "/")));
    const scopes = (json.scope || "").split(/\s+/).filter(Boolean);
    return scopes.includes("playlist-read-private");
  } catch {
    return true;
  }
}

function updateLoadButtonState() {
  const btn = document.getElementById("btn-load");
  if (!btn) return;
  const token = getAccessToken();
  if (!token || !tokenHasPlaylistReadScope(token)) {
    btn.disabled = true;
    return;
  }
  const url = (document.getElementById("spotify-url")?.value || "").trim();
  const hasPreset = selectedPresetId != null;
  const hasUrl = url.length > 0;
  btn.disabled = !(hasPreset || hasUrl);
}

function clearPresetSelectionUI() {
  selectedPresetId = null;
  document.querySelectorAll("#preset-buttons .btn-preset").forEach((b) => {
    b.classList.remove("preset-selected");
    b.setAttribute("aria-pressed", "false");
  });
  updateLoadButtonState();
}

function selectPreset(preset) {
  if (selectedPresetId === preset.id) {
    clearPresetSelectionUI();
    return;
  }
  selectedPresetId = preset.id;
  const urlInput = document.getElementById("spotify-url");
  if (urlInput) urlInput.value = "";
  document.querySelectorAll("#preset-buttons .btn-preset").forEach((b) => {
    const isSel = b.dataset.presetId === preset.id;
    b.classList.toggle("preset-selected", isSel);
    b.setAttribute("aria-pressed", isSel ? "true" : "false");
  });
  updateLoadButtonState();
}

function clearAuth() {
  sessionStorage.removeItem(SS_TOKEN);
  sessionStorage.removeItem(SS_EXPIRES);
  clearPresetSelectionUI();
  updateSpotifySignOutVisibility();
  void refreshSpotifyUserDisplay();
}

function parseSpotifyInput(input) {
  const s = input.trim();
  const m = s.match(/spotify\.com\/(?:intl-[a-z]{2}\/)?(playlist|artist|album|track)\/([a-zA-Z0-9]+)/);
  if (!m) return null;
  return { type: m[1], id: m[2] };
}

function spotifyApiErrorMessage(body) {
  if (!body || typeof body !== "object") return "";
  const e = body.error;
  if (typeof e === "string") return e;
  if (e && typeof e === "object" && typeof e.message === "string") return e.message;
  return "";
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function api(pathOrUrl, options = {}) {
  const token = getAccessToken();
  if (!token) throw new Error("Not signed in.");
  const url = pathOrUrl.startsWith("http")
    ? pathOrUrl
    : `https://api.spotify.com/v1${pathOrUrl}`;
  const maxAttempts = 6;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const res = await fetch(url, {
      ...options,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(options.headers || {}),
      },
    });
    if (res.status === 401) {
      clearAuth();
      throw new Error("Session expired. Sign in again.");
    }
    if (res.status === 429) {
      await res.text().catch(() => {});
      const raw = res.headers.get("Retry-After");
      let sec = 5;
      if (raw != null && raw !== "") {
        const n = parseFloat(raw);
        if (!Number.isNaN(n)) sec = Math.min(120, Math.max(1, n));
      } else {
        sec = 5 + Math.floor(Math.random() * 4);
      }
      if (attempt < maxAttempts - 1) {
        await sleep(sec * 1000 + Math.floor(Math.random() * 500));
        continue;
      }
      throw new Error(`Rate limited. Try again in ${raw || "a minute"} or load a smaller playlist.`);
    }
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      const detail = spotifyApiErrorMessage(err) || `${res.status} ${res.statusText}`;
      if (res.status === 403) {
        const lower = detail.toLowerCase();
        const scopeOrPerm =
          lower.includes("scope") ||
          lower.includes("permission") ||
          lower.includes("not authorized") ||
          lower.includes("insufficient");
        if (scopeOrPerm) {
          clearAuth();
          throw new Error(
            `${detail} Sign in again so Spotify can grant playlist access (your previous login may have been created before those permissions were added).`
          );
        }
        throw new Error(
          `${detail} If you’re on this app’s User list in the Spotify dashboard, try signing out and signing in again. Also confirm this site uses the same Client ID as that Spotify app (Developer setup).`
        );
      }
      throw new Error(detail);
    }
    return res.json();
  }
  throw new Error("Spotify API: too many retries.");
}

/** Human-readable label for default save names (playlist / artist / album title). */
async function fetchSpotifySourceLabel(parsed) {
  if (!parsed?.id || !parsed?.type) return null;
  try {
    if (parsed.type === "playlist") {
      const d = await api(`/playlists/${encodeURIComponent(parsed.id)}`);
      return `Playlist: ${d.name || "Playlist"}`;
    }
    if (parsed.type === "artist") {
      const d = await api(`/artists/${encodeURIComponent(parsed.id)}`);
      return `Artist: ${d.name || "Artist"}`;
    }
    if (parsed.type === "album") {
      const d = await api(`/albums/${encodeURIComponent(parsed.id)}`);
      return `Album: ${d.name || "Album"}`;
    }
  } catch {
    return null;
  }
  return null;
}

async function refreshSpotifyUserDisplay() {
  const el = document.getElementById("user-display");
  const authStatus = document.getElementById("auth-status");
  if (!el) return;
  if (!getAccessToken()) {
    el.classList.add("hidden");
    el.replaceChildren();
    return;
  }
  try {
    const me = await api("/me");
    const name = me.display_name || me.id || "Spotify";
    el.replaceChildren();
    el.classList.remove("hidden");
    el.appendChild(document.createTextNode("Signed in as "));
    const strong = document.createElement("strong");
    strong.textContent = name;
    el.appendChild(strong);
    if (authStatus && !authStatus.classList.contains("error")) {
      authStatus.textContent = "";
    }
  } catch {
    el.replaceChildren();
    el.classList.remove("hidden");
    el.appendChild(document.createTextNode("Signed in to Spotify."));
    if (authStatus && !authStatus.classList.contains("error")) {
      authStatus.textContent = "";
    }
  }
}

async function fetchAllPlaylistTracks(playlistId) {
  const out = [];
  const pageLimit = 50;
  let offset = 0;
  for (;;) {
    const data = await api(
      `/playlists/${encodeURIComponent(playlistId)}/items?limit=${pageLimit}&offset=${offset}`
    );
    const items = data.items || [];
    for (const item of items) {
      const t = item.track;
      if (!t || !t.id) continue;
      if (t.type === "episode") continue;
      out.push(normalizeTrack(t));
    }
    if (!items.length) break;
    offset += items.length;
    if (data.total != null && offset >= data.total) break;
    if (items.length < pageLimit) break;
    await sleep(160);
  }
  return dedupeById(out);
}

async function fetchAlbumTracks(albumId) {
  const meta = await api(`/albums/${encodeURIComponent(albumId)}`);
  const albumName = meta.name || "";
  const artistsMain = (meta.artists || []).map((a) => a.name).join(", ");
  const out = [];
  const pageLimit = 50;
  let offset = 0;
  for (;;) {
    const data = await api(
      `/albums/${encodeURIComponent(albumId)}/tracks?limit=${pageLimit}&offset=${offset}`
    );
    for (const t of data.items || []) {
      const artists = (t.artists || []).map((a) => a.name).join(", ") || artistsMain;
      out.push({
        id: t.id,
        name: t.name,
        artists,
        album: albumName,
        url: t.external_urls?.spotify || spotifyTrackUrl(t.id),
      });
    }
    const items = data.items || [];
    if (!items.length) break;
    offset += items.length;
    if (data.total != null && offset >= data.total) break;
    if (items.length < pageLimit) break;
    await sleep(160);
  }
  return dedupeById(out);
}

async function fetchArtistTracks(artistId) {
  const albumNames = new Map();
  const albums = new Set();
  const albumPageLimit = 10;
  let albumOffset = 0;
  for (;;) {
    const data = await api(
      `/artists/${encodeURIComponent(artistId)}/albums?include_groups=album,single&limit=${albumPageLimit}&offset=${albumOffset}`
    );
    const items = data.items || [];
    for (const a of items) {
      albums.add(a.id);
      albumNames.set(a.id, a.name);
    }
    if (!items.length) break;
    albumOffset += items.length;
    if (data.total != null && albumOffset >= data.total) break;
    if (items.length < albumPageLimit) break;
    await sleep(220);
  }

  const out = [];
  const trackPageLimit = 50;
  for (const albumId of albums) {
    await sleep(280);
    let trackOffset = 0;
    for (;;) {
      const data = await api(
        `/albums/${encodeURIComponent(albumId)}/tracks?limit=${trackPageLimit}&offset=${trackOffset}`
      );
      const items = data.items || [];
      for (const t of items) {
        const belongs = (t.artists || []).some((a) => a.id === artistId);
        if (!belongs) continue;
        const artists = (t.artists || []).map((a) => a.name).join(", ");
        out.push({
          id: t.id,
          name: t.name,
          artists,
          album: albumNames.get(albumId) || "",
          url: t.external_urls?.spotify || spotifyTrackUrl(t.id),
        });
      }
      if (!items.length) break;
      trackOffset += items.length;
      if (data.total != null && trackOffset >= data.total) break;
      if (items.length < trackPageLimit) break;
      await sleep(180);
    }
  }
  return dedupeById(out);
}

function normalizeTrack(t) {
  const artists = (t.artists || []).map((a) => a.name).join(", ");
  return {
    id: t.id,
    name: t.name,
    artists,
    album: t.album?.name || "",
    url: t.external_urls?.spotify || spotifyTrackUrl(t.id),
    previewUrl: t.preview_url || null,
  };
}

function spotifyTrackUrl(id) {
  return `https://open.spotify.com/track/${id}`;
}

function dedupeById(tracks) {
  const map = new Map();
  for (const t of tracks) {
    if (!map.has(t.id)) map.set(t.id, t);
    else {
      const cur = map.get(t.id);
      if (!cur.previewUrl && t.previewUrl) cur.previewUrl = t.previewUrl;
    }
  }
  return [...map.values()];
}

async function enrichTracksWithPreviews(tracks) {
  const ids = [];
  for (const t of tracks) {
    if (t.previewUrl || !t.id || String(t.id).startsWith("manual")) continue;
    ids.push(t.id);
  }
  const unique = [...new Set(ids)];
  const chunk = 50;
  for (let i = 0; i < unique.length; i += chunk) {
    if (i > 0) await sleep(220);
    const slice = unique.slice(i, i + chunk);
    const data = await api(`/tracks?ids=${slice.map(encodeURIComponent).join(",")}`);
    const byId = new Map((data.tracks || []).filter(Boolean).map((tr) => [tr.id, tr]));
    for (const t of tracks) {
      const tr = byId.get(t.id);
      if (tr && !t.previewUrl) t.previewUrl = tr.preview_url || null;
    }
  }
}

/**
 * Curated presets (Spotify artist IDs). Add entries: { id, label }.
 * @see https://open.spotify.com/artist/…
 */
const RANK_PRESETS = [{ id: "5K4W6rqBFWDnAN6FQUkS6x", label: "Kanye West" }];

async function startRankingFromPreset(preset) {
  const status = document.getElementById("load-status");
  status.textContent = "Loading…";
  try {
    const tracks = await fetchArtistTracks(preset.id);
    if (tracks.length < 2) {
      status.textContent = "Need at least two tracks to rank.";
      status.classList.add("error");
      return;
    }
    status.textContent = "Loading previews…";
    await enrichTracksWithPreviews(tracks);
    status.textContent = `Loaded ${tracks.length} tracks.`;
    await runRanking(tracks, { sourceLabel: `Artist: ${preset.label}` });
  } catch (e) {
    status.textContent = e.message || String(e);
    status.classList.add("error");
  }
}

/** Guess a save label from track metadata (e.g. single artist or album). */
function guessLabelFromTracks(tracks) {
  if (!tracks?.length) return null;
  const artistNames = new Set();
  for (const t of tracks) {
    if (t.artists) {
      for (const part of t.artists.split(",")) {
        const s = part.trim();
        if (s) artistNames.add(s);
      }
    }
  }
  if (artistNames.size === 1) return `Artist: ${[...artistNames][0]}`;
  const albums = [...new Set(tracks.map((t) => t.album).filter(Boolean))];
  if (albums.length === 1) return `Album: ${albums[0]}`;
  return `Manual list (${tracks.length} songs)`;
}

/** --- UI state --- */

let compareStep = 0;
let compareEstimate = 0;
let pendingResolve = null;

function estimateMergeComparisons(n) {
  if (n <= 1) return 0;
  return Math.ceil(n * Math.ceil(Math.log2(n)));
}

/** Rough upper bound for “top k” mode (fewer pairs than full sort when k ≪ n). */
function estimateTopNComparisons(n, k) {
  if (n <= 1) return 0;
  if (!k || k >= n) return estimateMergeComparisons(n);
  const kk = Math.min(k, n);
  return Math.ceil(n * Math.ceil(Math.log2(kk + 1)));
}

function updateProgress() {
  const fill = document.getElementById("progress-fill");
  const text = document.getElementById("progress-text");
  if (!fill || !text) return;
  const pct = compareEstimate ? Math.min(100, (compareStep / compareEstimate) * 100) : 0;
  fill.style.width = `${pct}%`;
  text.textContent = compareEstimate ? `~${compareStep} / ~${compareEstimate} choices` : "";
}

function showComparePanel(show) {
  document.getElementById("panel-setup")?.classList.toggle("hidden", show);
  document.getElementById("panel-compare")?.classList.toggle("hidden", !show);
  document.getElementById("compare-kb-hint")?.setAttribute("aria-hidden", show ? "false" : "true");
}

function showResultsPanel(show) {
  document.getElementById("panel-results")?.classList.toggle("hidden", !show);
}

function spotifyTrackIdForEmbed(track) {
  let id = track?.id;
  if (!id || String(id).startsWith("manual")) {
    const u = track?.url;
    if (u && u !== "#") {
      const m = String(u).match(/track\/([a-zA-Z0-9]+)/);
      if (m) id = m[1];
    }
  }
  if (!id || String(id).startsWith("manual")) return "";
  return id;
}

function spotifyEmbedSrc(track) {
  const id = spotifyTrackIdForEmbed(track);
  if (!id) return "";
  return `https://open.spotify.com/embed/track/${encodeURIComponent(id)}?theme=0`;
}

function setTrackEmbed(iframeId, wrapId, track) {
  const iframe = document.getElementById(iframeId);
  const wrap = document.getElementById(wrapId);
  if (!iframe || !wrap) return;
  const src = spotifyEmbedSrc(track);
  if (src) {
    wrap.classList.remove("hidden");
    iframe.setAttribute("title", `Spotify preview: ${track.name}`);
    iframe.src = src;
  } else {
    iframe.removeAttribute("src");
    wrap.classList.add("hidden");
  }
}

function renderPair(a, b) {
  const blind = !!currentBlindMode;
  const panel = document.getElementById("panel-compare");
  panel?.classList.toggle("blind-mode", blind);

  if (blind) {
    document.getElementById("embed-wrap-a")?.classList.add("hidden");
    document.getElementById("embed-wrap-b")?.classList.add("hidden");
    document.getElementById("embed-a")?.removeAttribute("src");
    document.getElementById("embed-b")?.removeAttribute("src");
    document.getElementById("blind-wrap-a")?.classList.remove("hidden");
    document.getElementById("blind-wrap-b")?.classList.remove("hidden");

    document.getElementById("title-a").textContent = "Side A";
    document.getElementById("meta-a").textContent = "Listen · pick the clip you prefer";
    document.getElementById("title-b").textContent = "Side B";
    document.getElementById("meta-b").textContent = "Listen · pick the clip you prefer";
    document.getElementById("card-a")?.setAttribute("aria-label", "Prefer side A");
    document.getElementById("card-b")?.setAttribute("aria-label", "Prefer side B");

    const puA = a.previewUrl || "";
    const puB = b.previewUrl || "";
    const audioA = document.getElementById("audio-a");
    const audioB = document.getElementById("audio-b");
    if (audioA) {
      audioA.pause();
      audioA.src = puA || "";
      audioA.load();
    }
    if (audioB) {
      audioB.pause();
      audioB.src = puB || "";
      audioB.load();
    }
    document.getElementById("blind-no-preview-a")?.classList.toggle("hidden", !!puA);
    document.getElementById("blind-no-preview-b")?.classList.toggle("hidden", !!puB);
  } else {
    document.getElementById("blind-wrap-a")?.classList.add("hidden");
    document.getElementById("blind-wrap-b")?.classList.add("hidden");
    document.getElementById("embed-a")?.removeAttribute("src");
    document.getElementById("embed-b")?.removeAttribute("src");
    const audioA = document.getElementById("audio-a");
    const audioB = document.getElementById("audio-b");
    if (audioA) {
      audioA.pause();
      audioA.removeAttribute("src");
    }
    if (audioB) {
      audioB.pause();
      audioB.removeAttribute("src");
    }
    document.getElementById("title-a").textContent = a.name;
    document.getElementById("meta-a").textContent = [a.artists, a.album].filter(Boolean).join(" · ");
    document.getElementById("title-b").textContent = b.name;
    document.getElementById("meta-b").textContent = [b.artists, b.album].filter(Boolean).join(" · ");
    document.getElementById("card-a")?.setAttribute("aria-label", `Prefer ${a.name}`);
    document.getElementById("card-b")?.setAttribute("aria-label", `Prefer ${b.name}`);
    setTrackEmbed("embed-a", "embed-wrap-a", a);
    setTrackEmbed("embed-b", "embed-wrap-b", b);
  }
}

function shuffleInPlace(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}

/** Directed edges: winnerId → loserId means “winner preferred over loser”. Used to skip redundant merge questions. */
const CMP_UNDO = Symbol("cmpUndo");
const CMP_ABORT = Symbol("cmpAbort");

let preferenceAdj = null;
/** Stack of recorded preferences (not skips); each entry has track refs to re-ask that pair on undo. */
let choiceHistory = [];
/** After undo, re-ask this pair before picking another from the graph. */
let undoForcedPair = null;
/** Skip counts per pair (pairKey → times deferred); must persist for resume. */
let rankingDeferredCounts = new Map();
/** User chose Home while ranking; checked each comparison turn. */
let rankingAbortRequested = false;
/** Playlist / artist / album (or guessed) label for default save names. */
let rankingSourceLabel = null;
/** null = full order; number = stop at top N (fewer comparisons). */
let currentRankingTopN = null;
/** Blind compare: hide titles and embeds; use preview MP3 only. */
let currentBlindMode = false;
/** Snapshot for share link (topN + label); cleared when session ends. */
let lastShareMeta = null;

function resetPreferenceGraph() {
  preferenceAdj = new Map();
  choiceHistory = [];
  undoForcedPair = null;
  rankingDeferredCounts = new Map();
}

function recordPreference(winnerId, loserId) {
  if (!preferenceAdj.has(winnerId)) preferenceAdj.set(winnerId, new Set());
  preferenceAdj.get(winnerId).add(loserId);
}

function removePreferenceEdge(winnerId, loserId) {
  const s = preferenceAdj.get(winnerId);
  if (!s) return;
  s.delete(loserId);
  if (s.size === 0) preferenceAdj.delete(winnerId);
}

function pushChoice(winnerId, loserId, a, b) {
  choiceHistory.push({ winnerId, loserId, a, b });
}

function isPreferredOver(preferredId, otherId) {
  if (preferredId === otherId) return false;
  const visited = new Set();
  const stack = [preferredId];
  while (stack.length) {
    const x = stack.pop();
    if (x === otherId) return true;
    if (visited.has(x)) continue;
    visited.add(x);
    for (const y of preferenceAdj.get(x) || []) {
      stack.push(y);
    }
  }
  return false;
}

function pairKey(a, b) {
  return a.id < b.id ? `${a.id}|${b.id}` : `${b.id}|${a.id}`;
}

function findIncomparablePairs(tracks) {
  const pairs = [];
  for (let i = 0; i < tracks.length; i++) {
    for (let j = i + 1; j < tracks.length; j++) {
      const a = tracks[i];
      const b = tracks[j];
      if (a.id === b.id) continue;
      if (!isPreferredOver(a.id, b.id) && !isPreferredOver(b.id, a.id)) {
        pairs.push([a, b]);
      }
    }
  }
  return pairs;
}

function countStrictlyPreferredAbove(allTracks, trackId) {
  let c = 0;
  for (const o of allTracks) {
    if (o.id === trackId) continue;
    if (isPreferredOver(o.id, trackId)) c += 1;
  }
  return c;
}

/** Tracks that can still place in the top-N band (fewer than N others strictly above). */
function getActiveTracksForTopN(allTracks, topN) {
  return allTracks.filter((t) => countStrictlyPreferredAbove(allTracks, t.id) < topN);
}

function pickNextPair(pairs) {
  const scored = pairs.map(([a, b]) => ({
    a,
    b,
    d: rankingDeferredCounts.get(pairKey(a, b)) || 0,
  }));
  scored.sort((x, y) => {
    if (x.d !== y.d) return x.d - y.d;
    return Math.random() - 0.5;
  });
  return [scored[0].a, scored[0].b];
}

function extractRanking(tracks) {
  const n = tracks.length;
  const idToTrack = new Map(tracks.map((t) => [t.id, t]));
  const indeg = new Map();
  for (const t of tracks) indeg.set(t.id, 0);
  for (const [, losers] of preferenceAdj) {
    for (const l of losers) {
      indeg.set(l, (indeg.get(l) || 0) + 1);
    }
  }
  const q = [];
  for (const t of tracks) {
    if ((indeg.get(t.id) || 0) === 0) q.push(t.id);
  }
  const ranked = [];
  while (q.length) {
    if (q.length > 1) {
      throw new Error("Ranking ambiguous; need more comparisons.");
    }
    const id = q.shift();
    ranked.push(idToTrack.get(id));
    for (const l of preferenceAdj.get(id) || []) {
      indeg.set(l, indeg.get(l) - 1);
      if (indeg.get(l) === 0) q.push(l);
    }
  }
  if (ranked.length !== n) {
    throw new Error("Preferential cycle detected; try ranking again.");
  }
  return ranked;
}

function extractRankingSubset(subsetTracks) {
  const ids = new Set(subsetTracks.map((t) => t.id));
  const n = subsetTracks.length;
  const idToTrack = new Map(subsetTracks.map((t) => [t.id, t]));
  const indeg = new Map();
  for (const t of subsetTracks) indeg.set(t.id, 0);
  for (const t of subsetTracks) {
    const w = t.id;
    for (const l of preferenceAdj.get(w) || []) {
      if (ids.has(l)) {
        indeg.set(l, (indeg.get(l) || 0) + 1);
      }
    }
  }
  const q = [];
  for (const t of subsetTracks) {
    if ((indeg.get(t.id) || 0) === 0) q.push(t.id);
  }
  const ranked = [];
  while (q.length) {
    if (q.length > 1) {
      throw new Error("Ranking ambiguous; need more comparisons.");
    }
    const id = q.shift();
    ranked.push(idToTrack.get(id));
    for (const l of preferenceAdj.get(id) || []) {
      if (!ids.has(l)) continue;
      indeg.set(l, indeg.get(l) - 1);
      if (indeg.get(l) === 0) q.push(l);
    }
  }
  if (ranked.length !== n) {
    throw new Error("Preferential cycle detected; try ranking again.");
  }
  return ranked;
}

/** Active session order (for save / resume); null when not ranking. */
let currentRankingOrder = null;
/** Current head-to-head on screen [idA, idB] while waiting for an answer. */
let pendingPairForSave = null;

function findTrackById(tracks, id) {
  return tracks.find((t) => t.id === id) || null;
}

function preferenceAdjToJSON() {
  const o = {};
  for (const [w, losers] of preferenceAdj) {
    o[w] = [...losers];
  }
  return o;
}

function preferenceAdjFromJSON(obj) {
  const m = new Map();
  if (!obj || typeof obj !== "object") return m;
  for (const [w, losers] of Object.entries(obj)) {
    m.set(w, new Set(Array.isArray(losers) ? losers : []));
  }
  return m;
}

function choiceHistoryToJSON() {
  return choiceHistory.map(({ winnerId, loserId, a, b }) => ({
    winnerId,
    loserId,
    aId: a.id,
    bId: b.id,
  }));
}

function reconstructChoiceHistory(entries, tracks) {
  const byId = new Map(tracks.map((t) => [t.id, t]));
  const out = [];
  for (const e of entries || []) {
    const a = byId.get(e.aId);
    const b = byId.get(e.bId);
    if (a && b) out.push({ winnerId: e.winnerId, loserId: e.loserId, a, b });
  }
  return out;
}

function getPendingPairIds() {
  if (undoForcedPair) return [undoForcedPair[0].id, undoForcedPair[1].id];
  if (pendingPairForSave) return [...pendingPairForSave];
  return null;
}

function buildProgressSnapshot() {
  if (!currentRankingOrder?.length) return null;
  return {
    v: 1,
    savedAt: Date.now(),
    tracks: currentRankingOrder.map((t) => ({ ...t })),
    adj: preferenceAdjToJSON(),
    choiceHistory: choiceHistoryToJSON(),
    deferred: [...rankingDeferredCounts.entries()],
    pendingPair: getPendingPairIds(),
    compareStep,
    compareEstimate,
    sourceLabel: rankingSourceLabel || null,
    rankingTopN: currentRankingTopN ?? null,
    blindMode: !!currentBlindMode,
  };
}

function applyResumeSnapshot(snap, order) {
  preferenceAdj = preferenceAdjFromJSON(snap.adj);
  choiceHistory = reconstructChoiceHistory(snap.choiceHistory, order);
  rankingDeferredCounts = new Map(snap.deferred || []);
  undoForcedPair = null;
  if (snap.pendingPair && snap.pendingPair.length === 2) {
    const ta = findTrackById(order, snap.pendingPair[0]);
    const tb = findTrackById(order, snap.pendingPair[1]);
    if (ta && tb) undoForcedPair = [ta, tb];
  }
  compareStep = snap.compareStep ?? 0;
  rankingSourceLabel = snap.sourceLabel || guessLabelFromTracks(order);
  currentRankingTopN = snap.rankingTopN != null ? Math.min(snap.rankingTopN, order.length) : null;
  if (currentRankingTopN != null && (currentRankingTopN < 2 || currentRankingTopN >= order.length)) {
    currentRankingTopN = null;
  }
  syncRankingModeSelect(currentRankingTopN, order.length);
  compareEstimate =
    snap.compareEstimate ??
    (currentRankingTopN != null
      ? estimateTopNComparisons(order.length, currentRankingTopN)
      : estimateMergeComparisons(order.length));
  currentBlindMode = snap.blindMode === true;
  syncExperienceSelect(currentBlindMode);
}

function isValidProgressSnapshot(o) {
  return (
    o &&
    o.v === 1 &&
    Array.isArray(o.tracks) &&
    o.tracks.length >= 2 &&
    o.adj &&
    typeof o.adj === "object"
  );
}

let progressAutosaveTimer = null;

function scheduleProgressAutosave() {
  if (!currentRankingOrder?.length) return;
  if (progressAutosaveTimer) clearTimeout(progressAutosaveTimer);
  progressAutosaveTimer = setTimeout(() => {
    progressAutosaveTimer = null;
    try {
      const snap = buildProgressSnapshot();
      if (!snap) return;
      localStorage.setItem(LS_PROGRESS_AUTOSAVE, JSON.stringify(snap));
      refreshProgressPicker();
    } catch (_) {}
  }, 450);
}

function clearProgressAutosave() {
  try {
    localStorage.removeItem(LS_PROGRESS_AUTOSAVE);
  } catch (_) {}
  refreshProgressPicker();
}

function getNamedProgressList() {
  try {
    const raw = localStorage.getItem(LS_PROGRESS_NAMED);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function setNamedProgressList(list) {
  localStorage.setItem(LS_PROGRESS_NAMED, JSON.stringify(list));
}

function refreshProgressPicker() {
  const sel = document.getElementById("progress-pick");
  if (!sel) return;
  const autosave = localStorage.getItem(LS_PROGRESS_AUTOSAVE);
  sel.innerHTML = '<option value="">Choose a session…</option>';
  if (autosave) {
    try {
      const snap = JSON.parse(autosave);
      const opt = document.createElement("option");
      opt.value = "__autosave__";
      const n = snap.tracks?.length || "?";
      const t = snap.savedAt ? new Date(snap.savedAt).toLocaleString() : "";
      const mode =
        snap.rankingTopN != null && snap.rankingTopN >= 2 ? ` · top ${snap.rankingTopN}` : "";
      opt.textContent = `In progress · ${n} songs${mode} · ${t}`;
      sel.appendChild(opt);
    } catch (_) {}
  }
  for (const s of getNamedProgressList().sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0))) {
    const opt = document.createElement("option");
    opt.value = s.id;
    const base = (s.name || "Untitled").slice(0, 72);
    const mode =
      s.snapshot?.rankingTopN != null && s.snapshot.rankingTopN >= 2
        ? ` · top ${s.snapshot.rankingTopN}`
        : "";
    opt.textContent = `${base}${mode}`;
    sel.appendChild(opt);
  }
}

function getSelectedProgressSnapshot() {
  const sel = document.getElementById("progress-pick");
  const id = sel?.value;
  if (!id) return null;
  if (id === "__autosave__") {
    const raw = localStorage.getItem(LS_PROGRESS_AUTOSAVE);
    if (!raw) return null;
    return JSON.parse(raw);
  }
  const found = getNamedProgressList().find((x) => x.id === id);
  return found?.snapshot || null;
}

function downloadTextFile(filename, text, mime) {
  const blob = new Blob([text], { type: mime });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

function saveProgressNow(statusEl) {
  const el = statusEl || document.getElementById("compare-save-status");
  const snap = buildProgressSnapshot();
  if (!snap) {
    if (el) el.textContent = "Nothing to save.";
    return;
  }
  try {
    localStorage.setItem(LS_PROGRESS_AUTOSAVE, JSON.stringify(snap));
    refreshProgressPicker();
    if (el) el.textContent = "Saved on this device.";
  } catch {
    if (el) el.textContent = "Couldn’t save (storage blocked or full).";
  }
}

function deleteSelectedProgress() {
  const sel = document.getElementById("progress-pick");
  const id = sel?.value;
  const status = document.getElementById("progress-status");
  if (!id) {
    if (status) {
      status.textContent = "Pick a session from the list first.";
      status.classList.add("error");
    }
    return;
  }
  if (id === "__autosave__") {
    if (!confirm("Delete your in-progress ranking from this device?")) return;
    clearProgressAutosave();
    if (status) {
      status.textContent = "Deleted.";
      status.classList.remove("error");
    }
    return;
  }
  if (!confirm("Delete this saved copy?")) return;
  const next = getNamedProgressList().filter((x) => x.id !== id);
  setNamedProgressList(next);
  refreshProgressPicker();
  if (status) {
    status.textContent = "Deleted.";
    status.classList.remove("error");
  }
}

function csvEscapeCell(s) {
  if (s == null) return "";
  const t = String(s);
  if (/[",\n\r]/.test(t)) return `"${t.replace(/"/g, '""')}"`;
  return t;
}

function exportRankingToJson() {
  const ranked = window.__lastRanked;
  const status = document.getElementById("copy-status");
  if (!ranked?.length) {
    status.textContent = "Nothing to export.";
    return;
  }
  const payload = {
    v: 1,
    type: "song_ranker_result",
    exportedAt: new Date().toISOString(),
    tracks: ranked.map((t) => ({ ...t })),
  };
  downloadTextFile(`song-ranker-results-${Date.now()}.json`, JSON.stringify(payload, null, 2), "application/json");
  status.textContent = "Download started.";
}

function exportRankingToCsv() {
  const ranked = window.__lastRanked;
  const status = document.getElementById("copy-status");
  if (!ranked?.length) {
    status.textContent = "Nothing to export.";
    return;
  }
  const lines = ["rank,title,artists,album,url"];
  ranked.forEach((t, i) => {
    lines.push([i + 1, t.name, t.artists || "", t.album || "", t.url || ""].map(csvEscapeCell).join(","));
  });
  downloadTextFile(`song-ranker-results-${Date.now()}.csv`, lines.join("\n"), "text/csv;charset=utf-8");
  status.textContent = "Download started.";
}

function encodeSharePayloadJson(obj) {
  const json = JSON.stringify(obj);
  const bytes = new TextEncoder().encode(json);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function buildSharePayloadFromState() {
  const ranked = window.__lastRanked;
  if (!ranked?.length) return null;
  const meta = lastShareMeta || { topN: null, sourceLabel: rankingSourceLabel };
  let goal = "full";
  if (meta.topN != null && meta.topN < ranked.length && meta.topN >= 2) {
    goal = meta.topN === 25 ? "top25" : meta.topN === 100 ? "top100" : `top${meta.topN}`;
  }
  return {
    v: 1,
    title: String(meta.sourceLabel || "Song ranking").slice(0, 200),
    createdAt: Date.now(),
    goal,
    tracks: ranked.map((t, i) => ({
      rank: i + 1,
      name: t.name,
      artists: t.artists || "",
      album: t.album || "",
      url: t.url || "",
    })),
  };
}

async function copyShareLink() {
  const el = document.getElementById("share-status");
  const payload = buildSharePayloadFromState();
  if (!payload) {
    if (el) el.textContent = "Nothing to share yet.";
    return;
  }
  const enc = encodeSharePayloadJson(payload);
  const url = `${new URL("viewer.html", window.location.href).href}#d=${enc}`;
  if (url.length > 48000) {
    if (el) el.textContent = "This list is too large for a link. Use Download HTML instead.";
    return;
  }
  try {
    await navigator.clipboard.writeText(url);
    if (el) el.textContent = "Link copied. Anyone can open it — no Spotify login.";
  } catch {
    if (el) el.textContent = "Could not copy. Try Download HTML or copy from the address bar.";
  }
}

async function downloadShareableStandaloneHtml() {
  const payload = buildSharePayloadFromState();
  const el = document.getElementById("share-status");
  if (!payload) {
    if (el) el.textContent = "Nothing to share yet.";
    return;
  }
  const safe = JSON.stringify(payload).replace(/</g, "\\u003c");
  const inject = `<script type="application/json" id="sr-data">${safe}<\/script>\n`;
  try {
    const res = await fetch(new URL("viewer.html", window.location.href));
    if (!res.ok) throw new Error("fetch");
    let html = await res.text();
    html = html.replace("<head>", `<head>\n${inject}`);
    const blob = new Blob([html], { type: "text/html;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `song-rank-share-${Date.now()}.html`;
    a.click();
    URL.revokeObjectURL(a.href);
    if (el) el.textContent = "Saved. Open or host the file — works offline.";
  } catch {
    if (el) el.textContent = "Could not build file. Serve the app over http(s), not file://.";
  }
}

function setDeferButtonVisible(show) {
  document.getElementById("btn-skip-pair")?.classList.toggle("hidden", !show);
  document.getElementById("skip-hint")?.classList.toggle("hidden", !show);
}

function getRankingModeFromUI(trackCount) {
  const sel = document.getElementById("ranking-mode");
  const v = sel?.value ?? "full";
  if (v === "full") return { topN: null };
  const n = parseInt(v, 10);
  if (!Number.isFinite(n) || n < 2) return { topN: null };
  if (n >= trackCount) return { topN: null };
  return { topN: n };
}

function syncRankingModeSelect(topN, trackCount) {
  const sel = document.getElementById("ranking-mode");
  if (!sel) return;
  if (topN == null || topN < 2 || topN >= trackCount) {
    sel.value = "full";
    return;
  }
  if (topN === 25) sel.value = "25";
  else if (topN === 100) sel.value = "100";
  else sel.value = "full";
}

function getExperienceFromUI() {
  return document.getElementById("compare-experience")?.value === "blind";
}

function syncExperienceSelect(blind) {
  const sel = document.getElementById("compare-experience");
  if (!sel) return;
  sel.value = blind ? "blind" : "standard";
}

async function rankWithPartialOrder(tracks, options = {}) {
  let topN = options.topN;
  if (topN != null && (topN >= tracks.length || topN < 2)) topN = null;

  function getIncomparablePairs() {
    if (!topN) return findIncomparablePairs(tracks);
    const active = getActiveTracksForTopN(tracks, topN);
    return findIncomparablePairs(active);
  }

  function finishTopNIfComplete() {
    if (!topN) return null;
    const active = getActiveTracksForTopN(tracks, topN);
    if (active.length === 0) {
      throw new Error("Could not determine a top list — try again.");
    }
    const ranked = extractRankingSubset(active);
    return ranked.slice(0, topN);
  }

  for (;;) {
    if (rankingAbortRequested) {
      rankingAbortRequested = false;
      throw Object.assign(new Error("Left ranking"), { code: "ABORT" });
    }
    let a;
    let b;
    let canDefer;
    if (undoForcedPair) {
      [a, b] = undoForcedPair;
      undoForcedPair = null;
      const incomparable = getIncomparablePairs();
      if (incomparable.length === 0) {
        if (topN) return finishTopNIfComplete();
        return extractRanking(tracks);
      }
      canDefer = incomparable.length > 1;
    } else {
      const incomparable = getIncomparablePairs();
      if (incomparable.length === 0) {
        if (topN) return finishTopNIfComplete();
        return extractRanking(tracks);
      }
      [a, b] = pickNextPair(incomparable);
      canDefer = incomparable.length > 1;
    }
    const key = pairKey(a, b);
    const cmp = await compareTracks(a, b, canDefer);
    if (cmp === CMP_ABORT) {
      throw Object.assign(new Error("Left ranking"), { code: "ABORT" });
    }
    if (cmp === CMP_UNDO) {
      continue;
    }
    if (cmp === 0) {
      if (canDefer) {
        rankingDeferredCounts.set(key, (rankingDeferredCounts.get(key) || 0) + 1);
        scheduleProgressAutosave();
        continue;
      }
      const tie = Math.random() < 0.5 ? -1 : 1;
      if (tie < 0) {
        recordPreference(a.id, b.id);
        pushChoice(a.id, b.id, a, b);
      } else {
        recordPreference(b.id, a.id);
        pushChoice(b.id, a.id, a, b);
      }
    } else if (cmp < 0) {
      recordPreference(a.id, b.id);
      pushChoice(a.id, b.id, a, b);
    } else {
      recordPreference(b.id, a.id);
      pushChoice(b.id, a.id, a, b);
    }
    scheduleProgressAutosave();
  }
}

function newSaveId() {
  if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
  return `s-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function getSavedRankings() {
  try {
    const raw = localStorage.getItem(LS_SAVED_RANKINGS);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function setSavedRankings(list) {
  localStorage.setItem(LS_SAVED_RANKINGS, JSON.stringify(list));
}

function renderSavedRankingsList() {
  const ul = document.getElementById("saved-rankings-list");
  const emptyEl = document.getElementById("saved-rankings-empty");
  if (!ul) return;
  const list = getSavedRankings();
  const sorted = [...list].sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0));
  ul.innerHTML = "";
  if (emptyEl) emptyEl.classList.toggle("hidden", sorted.length > 0);

  for (const s of sorted) {
    const li = document.createElement("li");
    li.className = "saved-ranking-item";
    const n = s.tracks?.length ?? 0;
    const name = (s.name || "Untitled").slice(0, 120);
    const date = s.savedAt
      ? new Date(s.savedAt).toLocaleDateString(undefined, { dateStyle: "medium" })
      : "";
    const metaBits = [`${n} song${n === 1 ? "" : "s"}`];
    if (date) metaBits.push(date);
    const meta = metaBits.join(" · ");

    const openBtn = document.createElement("button");
    openBtn.type = "button";
    openBtn.className = "saved-ranking-open";
    openBtn.dataset.id = s.id;
    const title = document.createElement("span");
    title.className = "saved-ranking-name";
    title.textContent = name;
    const sub = document.createElement("span");
    sub.className = "saved-ranking-meta";
    sub.textContent = meta;
    openBtn.appendChild(title);
    openBtn.appendChild(sub);

    const delBtn = document.createElement("button");
    delBtn.type = "button";
    delBtn.className = "btn secondary saved-ranking-delete";
    delBtn.dataset.id = s.id;
    delBtn.setAttribute("aria-label", `Remove ${name}`);
    delBtn.textContent = "Remove";

    li.appendChild(openBtn);
    li.appendChild(delBtn);
    ul.appendChild(li);
  }
}

let supabaseClient = null;

function getLocalSyncPayload() {
  return {
    v: 1,
    savedRankings: JSON.parse(localStorage.getItem(LS_SAVED_RANKINGS) || "[]"),
    namedProgress: JSON.parse(localStorage.getItem(LS_PROGRESS_NAMED) || "[]"),
    autosave: localStorage.getItem(LS_PROGRESS_AUTOSAVE),
  };
}

function applyCloudPayload(obj) {
  if (!obj || obj.v !== 1) throw new Error("That online backup isn’t valid.");
  localStorage.setItem(LS_SAVED_RANKINGS, JSON.stringify(Array.isArray(obj.savedRankings) ? obj.savedRankings : []));
  localStorage.setItem(LS_PROGRESS_NAMED, JSON.stringify(Array.isArray(obj.namedProgress) ? obj.namedProgress : []));
  if (obj.autosave && typeof obj.autosave === "string") {
    localStorage.setItem(LS_PROGRESS_AUTOSAVE, obj.autosave);
  } else {
    localStorage.removeItem(LS_PROGRESS_AUTOSAVE);
  }
  renderSavedRankingsList();
  refreshProgressPicker();
}

async function initCloudSync() {
  const url = (typeof window.SONG_RANKER_SUPABASE_URL === "string" ? window.SONG_RANKER_SUPABASE_URL : "").trim();
  const key = (typeof window.SONG_RANKER_SUPABASE_ANON_KEY === "string" ? window.SONG_RANKER_SUPABASE_ANON_KEY : "").trim();
  const cloudPanel = document.getElementById("cloud-panel");
  const statusEl = document.getElementById("cloud-status");
  const syncBtn = document.getElementById("btn-cloud-sync");
  const restoreBtn = document.getElementById("btn-cloud-restore");

  const setStatus = (text, isErr) => {
    if (!statusEl) return;
    statusEl.textContent = text;
    statusEl.classList.toggle("error", !!isErr);
  };

  const disableCloud = (msg) => {
    setStatus(msg, false);
    if (syncBtn) syncBtn.disabled = true;
    if (restoreBtn) restoreBtn.disabled = true;
  };

  if (!url || !key) {
    return;
  }

  if (cloudPanel) cloudPanel.classList.remove("hidden");

  if (window.location.protocol === "file:") {
    disableCloud("Save online works when this site is opened in the browser (not as a downloaded file).");
    return;
  }

  try {
    const mod = await import("https://esm.sh/@supabase/supabase-js@2.49.1");
    supabaseClient = mod.createClient(url, key, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
    });
  } catch (e) {
    disableCloud("Couldn’t load online backup. Try again later.");
    console.warn(e);
    return;
  }

  try {
    const { data: { session } } = await supabaseClient.auth.getSession();
    if (!session) {
      const { error } = await supabaseClient.auth.signInAnonymously();
      if (error) {
        setStatus("Online backup isn’t available right now. Try again later.", true);
        console.warn(error);
        if (syncBtn) syncBtn.disabled = true;
        if (restoreBtn) restoreBtn.disabled = true;
        return;
      }
    }
    setStatus("Your saves can be stored online so you can get them back on another device.");
  } catch (e) {
    setStatus("Online backup isn’t available right now. Try again later.", true);
    console.warn(e);
    if (syncBtn) syncBtn.disabled = true;
    if (restoreBtn) restoreBtn.disabled = true;
    return;
  }

  if (syncBtn) syncBtn.disabled = false;
  if (restoreBtn) restoreBtn.disabled = false;

  const wireOnce = (el, fn) => {
    if (!el || el.dataset.cloudWired) return;
    el.dataset.cloudWired = "1";
    el.addEventListener("click", fn);
  };

  wireOnce(syncBtn, async () => {
    const st = document.getElementById("cloud-status");
    try {
      if (st) {
        st.textContent = "Uploading…";
        st.classList.remove("error");
      }
      let { data: { session } } = await supabaseClient.auth.getSession();
      if (!session) {
        const { error } = await supabaseClient.auth.signInAnonymously();
        if (error) throw error;
        ({ data: { session } } = await supabaseClient.auth.getSession());
      }
      const uid = session?.user?.id;
      if (!uid) throw new Error("Not signed in.");
      const payload = getLocalSyncPayload();
      const { error } = await supabaseClient.from("song_ranker_sync").upsert(
        {
          user_id: uid,
          data: payload,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "user_id" }
      );
      if (error) throw error;
      if (st) {
        st.textContent = "Saved online.";
        st.classList.remove("error");
      }
    } catch (e) {
      if (st) {
        st.textContent = e.message || String(e);
        st.classList.add("error");
      }
    }
  });

  wireOnce(restoreBtn, async () => {
    const st = document.getElementById("cloud-status");
    try {
      if (!confirm("Replace this device’s saved lists and sessions with your online copy?")) return;
      if (st) {
        st.textContent = "Downloading…";
        st.classList.remove("error");
      }
      let { data: { session } } = await supabaseClient.auth.getSession();
      if (!session) {
        const { error } = await supabaseClient.auth.signInAnonymously();
        if (error) throw error;
        ({ data: { session } } = await supabaseClient.auth.getSession());
      }
      if (!session?.user?.id) throw new Error("Not signed in.");
      const { data, error } = await supabaseClient.from("song_ranker_sync").select("data").maybeSingle();
      if (error) throw error;
      if (!data?.data) throw new Error("Nothing saved online yet.");
      applyCloudPayload(data.data);
      if (st) {
        st.textContent = "Restored from online backup.";
        st.classList.remove("error");
      }
    } catch (e) {
      if (st) {
        st.textContent = e.message || String(e);
        st.classList.add("error");
      }
    }
  });
}

function renderRankedList(ranked) {
  const ol = document.getElementById("ranked-list");
  if (!ol) return;
  ol.innerHTML = "";
  ranked.forEach((t, idx) => {
    const li = document.createElement("li");
    const a = document.createElement("a");
    a.href = t.url || "#";
    a.target = "_blank";
    a.rel = "noopener";
    a.textContent = `${idx + 1}. ${t.name}${t.artists ? ` — ${t.artists}` : ""}`;
    li.appendChild(a);
    ol.appendChild(li);
  });
}

function applySaveNameSuggestion() {
  const inp = document.getElementById("save-name");
  if (!inp) return;
  const dateStr = new Date().toLocaleDateString(undefined, { dateStyle: "medium" });
  if (rankingSourceLabel) {
    inp.value = `${rankingSourceLabel} — ${dateStr}`;
  } else {
    inp.value = "";
    inp.placeholder = `Ranking — ${dateStr}`;
  }
}

function saveCurrentRanking() {
  const ranked = window.__lastRanked;
  const status = document.getElementById("copy-status");
  if (!ranked?.length) {
    status.textContent = "Nothing to save.";
    return;
  }
  let name = (document.getElementById("save-name")?.value || "").trim();
  const dateStr = new Date().toLocaleDateString(undefined, { dateStyle: "medium" });
  if (!name) {
    name = rankingSourceLabel ? `${rankingSourceLabel} — ${dateStr}` : `Ranking ${new Date().toLocaleString()}`;
  }
  const list = getSavedRankings();
  const entry = {
    id: newSaveId(),
    name,
    savedAt: Date.now(),
    tracks: ranked.map((t) => ({ ...t })),
  };
  if (rankingSourceLabel) entry.sourceLabel = rankingSourceLabel;
  list.push(entry);
  try {
    setSavedRankings(list);
    renderSavedRankingsList();
    status.textContent = "Saved on this device.";
    const sn = document.getElementById("save-name");
    if (sn) sn.value = "";
  } catch {
    status.textContent = "Could not save (storage blocked or full).";
  }
}

function loadSavedById(id) {
  const status = document.getElementById("saved-rankings-status");
  const found = getSavedRankings().find((s) => s.id === id);
  if (!found?.tracks?.length) {
    if (status) {
      status.textContent = "Could not load that list.";
      status.classList.add("error");
    }
    return;
  }
  const ranked = found.tracks.map((t) => ({ ...t }));
  window.__lastRanked = ranked;
  rankingSourceLabel = found.sourceLabel || guessLabelFromTracks(found.tracks);
  lastShareMeta = { topN: null, sourceLabel: rankingSourceLabel };
  renderRankedList(ranked);
  applySaveNameSuggestion();
  showComparePanel(false);
  showResultsPanel(true);
  document.getElementById("panel-setup")?.classList.add("hidden");
  if (status) {
    status.textContent = "";
    status.classList.remove("error");
  }
  document.getElementById("copy-status").textContent = "";
}

function deleteSavedById(id) {
  const status = document.getElementById("saved-rankings-status");
  if (!confirm("Delete this ranking from this device?")) return;
  const next = getSavedRankings().filter((s) => s.id !== id);
  setSavedRankings(next);
  renderSavedRankingsList();
  if (status) {
    status.textContent = "Deleted.";
    status.classList.remove("error");
  }
}

function updateUndoButton() {
  const btn = document.getElementById("btn-undo");
  if (!btn) return;
  btn.disabled = !(choiceHistory.length > 0 && pendingResolve);
}

function compareTracks(a, b, canDefer = true) {
  pendingPairForSave = [a.id, b.id];
  return new Promise((resolve) => {
    pendingResolve = (value) => {
      if (value !== 0 && value !== CMP_UNDO && value !== CMP_ABORT) compareStep += 1;
      updateProgress();
      resolve(value);
    };
    setDeferButtonVisible(canDefer);
    renderPair(a, b);
    updateUndoButton();
  });
}

function wireCompareCards() {
  const cardA = document.getElementById("card-a");
  const cardB = document.getElementById("card-b");
  cardA?.addEventListener("click", (e) => {
    e.preventDefault();
    if (!pendingResolve) return;
    const r = pendingResolve;
    pendingResolve = null;
    r(-1);
  });
  cardB?.addEventListener("click", (e) => {
    e.preventDefault();
    if (!pendingResolve) return;
    const r = pendingResolve;
    pendingResolve = null;
    r(1);
  });
  document.getElementById("btn-skip-pair")?.addEventListener("click", (e) => {
    e.preventDefault();
    if (!pendingResolve) return;
    const r = pendingResolve;
    pendingResolve = null;
    r(0);
  });
  document.getElementById("btn-undo")?.addEventListener("click", (e) => {
    e.preventDefault();
    if (!pendingResolve || choiceHistory.length === 0) return;
    const last = choiceHistory.pop();
    removePreferenceEdge(last.winnerId, last.loserId);
    compareStep = Math.max(0, compareStep - 1);
    updateProgress();
    undoForcedPair = [last.a, last.b];
    const r = pendingResolve;
    pendingResolve = null;
    r(CMP_UNDO);
    scheduleProgressAutosave();
  });
}

async function runRanking(tracks, options = {}) {
  const resume = options.resumeSnapshot;
  if (!resume && (!tracks || tracks.length === 0)) return;
  if (resume && (!resume.tracks || resume.tracks.length < 2)) return;

  lastShareMeta = null;
  rankingAbortRequested = false;
  let order;
  if (resume) {
    order = resume.tracks.map((t) => ({ ...t }));
    applyResumeSnapshot(resume, order);
    currentRankingOrder = order;
    if (currentBlindMode && getAccessToken()) {
      try {
        await enrichTracksWithPreviews(order);
      } catch (_) {}
    }
  } else {
    order = [...tracks];
    shuffleInPlace(order);
    resetPreferenceGraph();
    compareStep = 0;
    currentBlindMode = options.blindMode !== undefined ? !!options.blindMode : getExperienceFromUI();
    let effTop =
      options.topN !== undefined ? options.topN : getRankingModeFromUI(order.length).topN;
    if (effTop != null) {
      effTop = Math.min(Math.floor(effTop), order.length);
      if (effTop < 2 || effTop >= order.length) effTop = null;
    }
    currentRankingTopN = effTop;
    compareEstimate =
      currentRankingTopN != null
        ? estimateTopNComparisons(order.length, currentRankingTopN)
        : estimateMergeComparisons(order.length);
    if (options.topN !== undefined) syncRankingModeSelect(currentRankingTopN, order.length);
    currentRankingOrder = order;
    const sl = options.sourceLabel;
    rankingSourceLabel =
      sl != null && String(sl).trim() !== "" ? String(sl).trim() : guessLabelFromTracks(order);
  }

  updateProgress();
  showComparePanel(true);
  showResultsPanel(false);

  try {
    const ranked = await rankWithPartialOrder(order, { topN: currentRankingTopN });
    lastShareMeta = { topN: currentRankingTopN, sourceLabel: rankingSourceLabel };
    showComparePanel(false);
    showResultsPanel(true);
    window.__lastRanked = ranked;
    const hint = document.getElementById("results-mode-hint");
    if (hint) {
      if (currentRankingTopN != null && currentRankingTopN < order.length) {
        hint.textContent = `Goal: top ${currentRankingTopN} (of ${order.length} loaded).`;
        hint.classList.remove("hidden");
      } else {
        hint.textContent = "";
        hint.classList.add("hidden");
      }
    }
    renderRankedList(ranked);
    applySaveNameSuggestion();
    clearProgressAutosave();
  } catch (e) {
    if (e && e.code === "ABORT") {
      showComparePanel(false);
      showResultsPanel(false);
      document.getElementById("panel-setup")?.classList.remove("hidden");
      const st = document.getElementById("load-status");
      if (st) {
        st.textContent = "";
        st.classList.remove("error");
      }
      return;
    }
    showComparePanel(false);
    showResultsPanel(false);
    document.getElementById("panel-setup")?.classList.remove("hidden");
    const st = document.getElementById("load-status");
    if (st) {
      st.textContent = e.message || String(e);
      st.classList.add("error");
    }
  } finally {
    rankingAbortRequested = false;
    currentRankingOrder = null;
    pendingPairForSave = null;
    currentRankingTopN = null;
    currentBlindMode = false;
  }
}

function backToLanding() {
  const resultsPanel = document.getElementById("panel-results");
  const comparePanel = document.getElementById("panel-compare");
  const resultsVisible = resultsPanel && !resultsPanel.classList.contains("hidden");
  const compareVisible = comparePanel && !comparePanel.classList.contains("hidden");

  if (compareVisible) {
    if (pendingResolve) {
      if (
        !confirm(
          "Leave this ranking? Your place is saved—you can tap Continue on the home screen to pick it up again."
        )
      ) {
        return;
      }
      const r = pendingResolve;
      pendingResolve = null;
      r(CMP_ABORT);
      return;
    }
    rankingAbortRequested = true;
    return;
  }
  if (resultsVisible) {
    rankingSourceLabel = null;
    window.__lastRanked = null;
    lastShareMeta = null;
    showComparePanel(false);
    showResultsPanel(false);
    document.getElementById("panel-setup")?.classList.remove("hidden");
    document.getElementById("copy-status").textContent = "";
    const sn = document.getElementById("save-name");
    if (sn) sn.value = "";
  }
}

function exchangeCodeForToken(code, verifier, clientId) {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri(),
    client_id: clientId,
    code_verifier: verifier,
  });
  return fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  }).then(async (res) => {
    const data = await res.json();
    if (!res.ok) throw new Error(data.error_description || data.error || "Token exchange failed");
    return data;
  });
}

async function handleAuthReturn() {
  const params = new URLSearchParams(window.location.search);
  const code = params.get("code");
  const err = params.get("error");
  if (err) {
    document.getElementById("auth-status").textContent = `Sign-in error: ${params.get("error_description") || err}`;
    document.getElementById("auth-status").classList.add("error");
    window.history.replaceState({}, "", window.location.pathname);
    return;
  }
  if (!code) return;

  const verifier = sessionStorage.getItem(SS_VERIFIER);
  const clientId = getEffectiveClientId();
  if (!verifier || !clientId) {
    document.getElementById("auth-status").textContent = "Missing PKCE state. Set Client ID (or config.js) and try Sign in again.";
    document.getElementById("auth-status").classList.add("error");
    window.history.replaceState({}, "", window.location.pathname);
    return;
  }

  try {
    const data = await exchangeCodeForToken(code, verifier, clientId);
    setAccessToken(data.access_token, data.expires_in);
    sessionStorage.removeItem(SS_VERIFIER);
    const granted = new Set((data.scope || "").split(/\s+/).filter(Boolean));
    if (!granted.has("playlist-read-private")) {
      const authEl = document.getElementById("auth-status");
      if (authEl) {
        authEl.textContent =
          "Spotify did not grant playlist access. In the Spotify Developer Dashboard, open your app → Settings and ensure playlist scopes are enabled, then use Sign out and sign in again.";
        authEl.classList.add("error");
      }
    } else {
      document.getElementById("auth-status").classList.remove("error");
    }
    await refreshSpotifyUserDisplay();
    updateSpotifySignOutVisibility();
    updateLoadButtonState();
  } catch (e) {
    document.getElementById("auth-status").textContent = e.message || String(e);
    document.getElementById("auth-status").classList.add("error");
  }
  window.history.replaceState({}, "", window.location.pathname);
}

async function startLogin() {
  const clientId = getEffectiveClientId();
  if (!clientId) {
    document.getElementById("auth-status").textContent = "Set Client ID in config.js or paste it above and save.";
    document.getElementById("auth-status").classList.add("error");
    return;
  }
  const { verifier, challenge } = await generatePkce();
  sessionStorage.setItem(SS_VERIFIER, verifier);

  const auth = new URL("https://accounts.spotify.com/authorize");
  auth.searchParams.set("client_id", clientId);
  auth.searchParams.set("response_type", "code");
  auth.searchParams.set("redirect_uri", redirectUri());
  auth.searchParams.set("scope", AUTH_SCOPES);
  auth.searchParams.set("code_challenge_method", "S256");
  auth.searchParams.set("code_challenge", challenge);

  window.location.href = auth.toString();
}

function updateSpotifySignOutVisibility() {
  const btn = document.getElementById("btn-logout-spotify");
  if (!btn) return;
  btn.classList.toggle("hidden", !getAccessToken());
}

function signOutSpotify() {
  clearAuth();
  const authEl = document.getElementById("auth-status");
  if (authEl) {
    authEl.textContent = "Signed out. Sign in again to continue.";
    authEl.classList.remove("error");
  }
}

function applyTheme(mode) {
  const h = document.documentElement;
  h.classList.remove("theme-dark", "theme-light", "theme-auto");
  if (mode === "light") h.classList.add("theme-light");
  else if (mode === "auto") h.classList.add("theme-auto");
  else h.classList.add("theme-dark");
}

function initTheme() {
  const saved = localStorage.getItem(LS_THEME) || "dark";
  const sel = document.getElementById("theme-select");
  const v = saved === "light" || saved === "dark" || saved === "auto" ? saved : "dark";
  if (sel) sel.value = v;
  applyTheme(v);
  sel?.addEventListener("change", () => {
    localStorage.setItem(LS_THEME, sel.value);
    applyTheme(sel.value);
  });
}

function initCompareKeyboard() {
  document.addEventListener("keydown", (e) => {
    const comparePanel = document.getElementById("panel-compare");
    if (!comparePanel || comparePanel.classList.contains("hidden")) return;
    if (!pendingResolve) return;
    if (e.target?.closest?.("audio")) return;
    const tag = e.target?.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const k = e.key.toLowerCase();
    if (k === "u") {
      document.getElementById("btn-undo")?.click();
      return;
    }
    if (k === "s") {
      document.getElementById("btn-skip-pair")?.click();
      return;
    }
    let choice = null;
    if (k === "1" || e.key === "ArrowLeft") choice = -1;
    else if (k === "2" || e.key === "ArrowRight") choice = 1;
    else return;
    e.preventDefault();
    const pr = pendingResolve;
    if (!pr) return;
    pendingResolve = null;
    pr(choice);
  });
}

/** Optional gitignored config.js for online backup keys. Missing file is normal on static hosts. */
function loadOptionalConfigScript() {
  return new Promise((resolve) => {
    const s = document.createElement("script");
    s.src = "config.js?v=29";
    s.onload = () => resolve();
    s.onerror = () => resolve();
    document.head.appendChild(s);
  });
}

async function init() {
  await loadOptionalConfigScript();
  initTheme();
  initCompareKeyboard();
  renderSavedRankingsList();
  refreshProgressPicker();
  await initCloudSync();
  setRedirectDisplay();
  if (window.location.protocol === "file:") {
    const auth = document.getElementById("auth-status");
    if (auth) {
      auth.textContent =
        "Open over HTTP, not file://. Try: python3 -m http.server 8765 → http://127.0.0.1:8765/";
      auth.classList.add("error");
    }
  }
  wireCompareCards();

  const bakedId = (typeof window.SONG_RANKER_CLIENT_ID === "string" ? window.SONG_RANKER_CLIENT_ID : "").trim();
  const clientSetup = document.getElementById("client-setup-block");
  if (bakedId && clientSetup) {
    clientSetup.classList.add("hidden");
  }

  const clientInput = document.getElementById("client-id");
  if (clientInput) clientInput.value = getStoredClientId();

  document.getElementById("btn-save-client")?.addEventListener("click", () => {
    setStoredClientId(clientInput.value);
    document.getElementById("auth-status").textContent = clientInput.value ? "Client ID saved." : "Cleared.";
    document.getElementById("auth-status").classList.remove("error");
  });

  document.getElementById("btn-login")?.addEventListener("click", startLogin);

  if (getAccessToken()) {
    refreshSpotifyUserDisplay().catch(() => {});
  }
  updateSpotifySignOutVisibility();
  updateLoadButtonState();

  document.getElementById("btn-logout-spotify")?.addEventListener("click", signOutSpotify);

  handleAuthReturn().catch(() => {});

  document.getElementById("btn-load")?.addEventListener("click", async () => {
    const status = document.getElementById("load-status");
    status.textContent = "";
    status.classList.remove("error");

    if (!getAccessToken()) {
      status.textContent = "Sign in with Spotify first.";
      status.classList.add("error");
      return;
    }

    const preset = selectedPresetId ? RANK_PRESETS.find((p) => p.id === selectedPresetId) : null;
    if (preset) {
      await startRankingFromPreset(preset);
      return;
    }

    const url = document.getElementById("spotify-url").value;
    const parsed = parseSpotifyInput(url);
    if (!parsed) {
      status.textContent = "Could not read a Spotify playlist or artist link.";
      status.classList.add("error");
      return;
    }

    status.textContent = "Loading…";
    try {
      let tracks;
      if (parsed.type === "playlist") tracks = await fetchAllPlaylistTracks(parsed.id);
      else if (parsed.type === "artist") tracks = await fetchArtistTracks(parsed.id);
      else if (parsed.type === "album") tracks = await fetchAlbumTracks(parsed.id);
      else if (parsed.type === "track") {
        status.textContent = "Load a playlist, artist, or album (single track is not enough to rank).";
        status.classList.add("error");
        return;
      } else {
        status.textContent = "Unsupported link type.";
        status.classList.add("error");
        return;
      }
      if (tracks.length < 2) {
        status.textContent = "Need at least two tracks to rank.";
        status.classList.add("error");
        return;
      }
      status.textContent = "Loading previews…";
      await enrichTracksWithPreviews(tracks);
      status.textContent = `Loaded ${tracks.length} tracks.`;
      const label = await fetchSpotifySourceLabel(parsed);
      await runRanking(tracks, { sourceLabel: label });
    } catch (e) {
      status.textContent = e.message || String(e);
      status.classList.add("error");
    }
  });

  document.getElementById("spotify-url")?.addEventListener("input", () => {
    const v = (document.getElementById("spotify-url")?.value || "").trim();
    if (v.length === 0) {
      updateLoadButtonState();
      return;
    }
    clearPresetSelectionUI();
  });

  const presetWrap = document.getElementById("preset-buttons");
  if (presetWrap) {
    presetWrap.setAttribute("role", "group");
    presetWrap.setAttribute("aria-label", "Quick start presets");
    for (const p of RANK_PRESETS) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "btn btn-preset";
      b.textContent = p.label;
      b.dataset.presetId = p.id;
      b.setAttribute("aria-pressed", "false");
      b.addEventListener("click", () => selectPreset(p));
      presetWrap.appendChild(b);
    }
  }

  document.getElementById("btn-save-ranking")?.addEventListener("click", saveCurrentRanking);

  document.getElementById("saved-rankings-list")?.addEventListener("click", (e) => {
    const del = e.target.closest(".saved-ranking-delete");
    const open = e.target.closest(".saved-ranking-open");
    if (del?.dataset.id) {
      e.preventDefault();
      deleteSavedById(del.dataset.id);
      return;
    }
    if (open?.dataset.id) loadSavedById(open.dataset.id);
  });

  document.getElementById("btn-save-ranking-progress")?.addEventListener("click", () => saveProgressNow());

  document.getElementById("btn-resume-progress")?.addEventListener("click", async () => {
    const snap = getSelectedProgressSnapshot();
    const st = document.getElementById("progress-status");
    const loadSt = document.getElementById("load-status");
    if (!snap || !isValidProgressSnapshot(snap)) {
      if (st) {
        st.textContent = "Pick a session from the list first.";
        st.classList.add("error");
      }
      return;
    }
    if (st) {
      st.textContent = "";
      st.classList.remove("error");
    }
    if (loadSt) {
      loadSt.textContent = "";
      loadSt.classList.remove("error");
    }
    await runRanking([], { resumeSnapshot: snap });
  });

  document.getElementById("btn-delete-progress")?.addEventListener("click", deleteSelectedProgress);

  document.getElementById("btn-export")?.addEventListener("click", () => {
    const ranked = window.__lastRanked;
    const copyStatus = document.getElementById("copy-status");
    if (!ranked?.length) {
      copyStatus.textContent = "Nothing to copy.";
      return;
    }
    const lines = ranked.map((t, i) => `${i + 1}. ${t.name}${t.artists ? ` — ${t.artists}` : ""} ${t.url}`);
    navigator.clipboard.writeText(lines.join("\n")).then(
      () => {
        copyStatus.textContent = "Copied to clipboard.";
      },
      () => {
        copyStatus.textContent = "Could not copy (permission denied).";
      }
    );
  });

  document.getElementById("btn-export-json")?.addEventListener("click", exportRankingToJson);
  document.getElementById("btn-export-csv")?.addEventListener("click", exportRankingToCsv);

  document.getElementById("btn-share-copy-link")?.addEventListener("click", () => {
    copyShareLink().catch(() => {});
  });
  document.getElementById("btn-share-download-page")?.addEventListener("click", () => {
    downloadShareableStandaloneHtml().catch(() => {});
  });

  document.getElementById("btn-restart")?.addEventListener("click", () => {
    const ranked = window.__lastRanked;
    if (!ranked?.length) return;
    runRanking([...ranked], {
      sourceLabel: rankingSourceLabel || guessLabelFromTracks(ranked),
    }).catch(() => {});
  });

  document.getElementById("btn-back-home-compare")?.addEventListener("click", (e) => {
    e.preventDefault();
    backToLanding();
  });
  document.getElementById("btn-back-home-results")?.addEventListener("click", (e) => {
    e.preventDefault();
    backToLanding();
  });

  document.getElementById("btn-new")?.addEventListener("click", () => {
    window.__lastRanked = null;
    lastShareMeta = null;
    rankingSourceLabel = null;
    showComparePanel(false);
    showResultsPanel(false);
    document.getElementById("panel-setup")?.classList.remove("hidden");
    document.getElementById("load-status").textContent = "";
    document.getElementById("copy-status").textContent = "";
    const sn = document.getElementById("save-name");
    if (sn) sn.value = "";
  });
}

init().catch((err) => console.error(err));
