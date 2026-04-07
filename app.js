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
const SS_VERIFIER = "song_ranker_pkce_verifier";
const SS_TOKEN = "song_ranker_access_token";
const SS_EXPIRES = "song_ranker_token_expires_at";

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

function clearAuth() {
  sessionStorage.removeItem(SS_TOKEN);
  sessionStorage.removeItem(SS_EXPIRES);
  void refreshSpotifyUserDisplay();
}

function parseSpotifyInput(input) {
  const s = input.trim();
  const m = s.match(/spotify\.com\/(?:intl-[a-z]{2}\/)?(playlist|artist|album|track)\/([a-zA-Z0-9]+)/);
  if (!m) return null;
  return { type: m[1], id: m[2] };
}

async function api(pathOrUrl, options = {}) {
  const token = getAccessToken();
  if (!token) throw new Error("Not signed in.");
  const url = pathOrUrl.startsWith("http")
    ? pathOrUrl
    : `https://api.spotify.com/v1${pathOrUrl}`;
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
    const retry = res.headers.get("Retry-After");
    throw new Error(`Rate limited. Try again in ${retry || "a few"} seconds.`);
  }
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    if (res.status === 403) {
      throw new Error(
        "Spotify returned 403 (forbidden). New Spotify apps are usually in Development mode: only accounts added under User management in your app’s settings can sign in or use the API. Add your friend’s Spotify email there, or request Extended Quota for a public app — see developer.spotify.com/dashboard."
      );
    }
    throw new Error(err.error?.message || `${res.status} ${res.statusText}`);
  }
  return res.json();
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
      `/playlists/${encodeURIComponent(playlistId)}/tracks?limit=${pageLimit}&offset=${offset}`
    );
    const items = data.items || [];
    for (const item of items) {
      const t = item.track;
      if (!t || !t.id) continue;
      out.push(normalizeTrack(t));
    }
    if (!items.length) break;
    offset += items.length;
    if (data.total != null && offset >= data.total) break;
    if (items.length < pageLimit) break;
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
  }

  const out = [];
  const trackPageLimit = 50;
  for (const albumId of albums) {
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
  };
}

function spotifyTrackUrl(id) {
  return `https://open.spotify.com/track/${id}`;
}

function dedupeById(tracks) {
  const map = new Map();
  for (const t of tracks) {
    if (!map.has(t.id)) map.set(t.id, t);
  }
  return [...map.values()];
}

/**
 * Curated presets (Spotify artist IDs). Add entries: { id, label }.
 * @see https://open.spotify.com/artist/…
 */
const RANK_PRESETS = [{ id: "5K4W6rqBFWDnAN6FQUkS6x", label: "Kanye West" }];

async function loadFromPreset(preset) {
  const status = document.getElementById("load-status");
  status.textContent = "";
  status.classList.remove("error");
  if (!getAccessToken()) {
    status.textContent = "Sign in with Spotify first.";
    status.classList.add("error");
    return;
  }
  status.textContent = "Loading…";
  try {
    const tracks = await fetchArtistTracks(preset.id);
    if (tracks.length < 2) {
      status.textContent = "Need at least two tracks to rank.";
      status.classList.add("error");
      return;
    }
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

function updateProgress() {
  const fill = document.getElementById("progress-fill");
  const text = document.getElementById("progress-text");
  if (!fill || !text) return;
  const pct = compareEstimate ? Math.min(100, (compareStep / compareEstimate) * 100) : 0;
  fill.style.width = `${pct}%`;
  text.textContent = compareEstimate
    ? `Question ${compareStep} of ~${compareEstimate} (upper bound; skips don’t count as decisions)`
    : "";
}

function showComparePanel(show) {
  document.getElementById("panel-setup")?.classList.toggle("hidden", show);
  document.getElementById("panel-compare")?.classList.toggle("hidden", !show);
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
  document.getElementById("title-a").textContent = a.name;
  document.getElementById("meta-a").textContent = [a.artists, a.album].filter(Boolean).join(" · ");
  document.getElementById("title-b").textContent = b.name;
  document.getElementById("meta-b").textContent = [b.artists, b.album].filter(Boolean).join(" · ");
  setTrackEmbed("embed-a", "embed-wrap-a", a);
  setTrackEmbed("embed-b", "embed-wrap-b", b);
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
  compareEstimate = snap.compareEstimate ?? estimateMergeComparisons(order.length);
  rankingSourceLabel = snap.sourceLabel || guessLabelFromTracks(order);
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
  sel.innerHTML = '<option value="">— Pick a session —</option>';
  if (autosave) {
    try {
      const snap = JSON.parse(autosave);
      const opt = document.createElement("option");
      opt.value = "__autosave__";
      const n = snap.tracks?.length || "?";
      const t = snap.savedAt ? new Date(snap.savedAt).toLocaleString() : "";
      opt.textContent = `In progress · ${n} songs · ${t}`;
      sel.appendChild(opt);
    } catch (_) {}
  }
  for (const s of getNamedProgressList().sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0))) {
    const opt = document.createElement("option");
    opt.value = s.id;
    opt.textContent = (s.name || "Untitled").slice(0, 72);
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

function duplicateProgressAsNamed() {
  const snap = getSelectedProgressSnapshot();
  const status = document.getElementById("progress-status");
  if (!snap || !isValidProgressSnapshot(snap)) {
    if (status) {
      status.textContent = "Pick a session from the list first.";
      status.classList.add("error");
    }
    return;
  }
  const name = prompt("Name for this copy:");
  if (!name?.trim()) return;
  const list = getNamedProgressList();
  list.push({ id: newSaveId(), name: name.trim(), savedAt: Date.now(), snapshot: snap });
  setNamedProgressList(list);
  refreshProgressPicker();
  if (status) {
    status.textContent = "Copy saved.";
    status.classList.remove("error");
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

function exportProgressJsonFile() {
  const snap = buildProgressSnapshot() || getSelectedProgressSnapshot();
  const status = document.getElementById("progress-status");
  if (!snap) {
    if (status) {
      status.textContent = "Pick a session from the list, or save while you’re ranking.";
      status.classList.add("error");
    }
    return;
  }
  downloadTextFile(`song-ranker-progress-${Date.now()}.json`, JSON.stringify(snap, null, 2), "application/json");
  if (status) {
    status.textContent = "Download started.";
    status.classList.remove("error");
  }
}

function importProgressFromFile(file) {
  const reader = new FileReader();
  const status = document.getElementById("progress-status");
  reader.onload = () => {
    try {
      const snap = JSON.parse(reader.result);
      if (!isValidProgressSnapshot(snap)) throw new Error("Invalid song ranker progress file.");
      const list = getNamedProgressList();
      list.push({
        id: newSaveId(),
        name: `Imported ${new Date().toLocaleString()}`,
        savedAt: Date.now(),
        snapshot: snap,
      });
      setNamedProgressList(list);
      refreshProgressPicker();
      if (status) {
        status.textContent = "Uploaded. Pick it above and tap Continue.";
        status.classList.remove("error");
      }
    } catch (e) {
      if (status) {
        status.textContent = e.message || String(e);
        status.classList.add("error");
      }
    }
  };
  reader.readAsText(file);
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

function setDeferButtonVisible(show) {
  document.getElementById("btn-skip-pair")?.classList.toggle("hidden", !show);
  document.getElementById("skip-hint")?.classList.toggle("hidden", !show);
}

async function rankWithPartialOrder(tracks) {
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
      const incomparable = findIncomparablePairs(tracks);
      canDefer = incomparable.length > 1;
    } else {
      const incomparable = findIncomparablePairs(tracks);
      if (incomparable.length === 0) {
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

  rankingAbortRequested = false;
  let order;
  if (resume) {
    order = resume.tracks.map((t) => ({ ...t }));
    applyResumeSnapshot(resume, order);
    currentRankingOrder = order;
  } else {
    order = [...tracks];
    shuffleInPlace(order);
    resetPreferenceGraph();
    compareStep = 0;
    compareEstimate = estimateMergeComparisons(order.length);
    currentRankingOrder = order;
    const sl = options.sourceLabel;
    rankingSourceLabel =
      sl != null && String(sl).trim() !== "" ? String(sl).trim() : guessLabelFromTracks(order);
  }

  updateProgress();
  showComparePanel(true);
  showResultsPanel(false);

  try {
    const ranked = await rankWithPartialOrder(order);
    showComparePanel(false);
    showResultsPanel(true);
    window.__lastRanked = ranked;
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
    document.getElementById("auth-status").classList.remove("error");
    document.getElementById("btn-load").disabled = false;
    await refreshSpotifyUserDisplay();
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

function init() {
  renderSavedRankingsList();
  refreshProgressPicker();
  setRedirectDisplay();
  if (window.location.protocol === "file:") {
    const auth = document.getElementById("auth-status");
    if (auth) {
      auth.textContent =
        "Open this folder over HTTP (not file://) so Spotify sign-in works. In a terminal: cd here, then run: python3 -m http.server 8765 — then visit http://127.0.0.1:8765/";
      auth.classList.add("error");
    }
  }
  wireCompareCards();

  const bakedId = (typeof window.SONG_RANKER_CLIENT_ID === "string" ? window.SONG_RANKER_CLIENT_ID : "").trim();
  const clientSetup = document.getElementById("client-setup-block");
  const hintConnect = document.getElementById("hint-connect");
  if (bakedId && clientSetup) {
    clientSetup.classList.add("hidden");
    if (hintConnect) {
      hintConnect.innerHTML =
        "Click <strong>Sign in with Spotify</strong> and use your Spotify account. (The site owner has already connected this app to Spotify.)";
    }
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
    document.getElementById("btn-load").disabled = false;
    refreshSpotifyUserDisplay().catch(() => {});
  }

  handleAuthReturn().catch(() => {});

  document.getElementById("btn-load")?.addEventListener("click", async () => {
    const url = document.getElementById("spotify-url").value;
    const status = document.getElementById("load-status");
    status.textContent = "";
    status.classList.remove("error");

    const parsed = parseSpotifyInput(url);
    if (!parsed) {
      status.textContent = "Could not read a Spotify playlist or artist link.";
      status.classList.add("error");
      return;
    }
    if (!getAccessToken()) {
      status.textContent = "Sign in with Spotify first.";
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
      status.textContent = `Loaded ${tracks.length} tracks.`;
      const label = await fetchSpotifySourceLabel(parsed);
      await runRanking(tracks, { sourceLabel: label });
    } catch (e) {
      status.textContent = e.message || String(e);
      status.classList.add("error");
    }
  });

  const presetWrap = document.getElementById("preset-buttons");
  if (presetWrap) {
    for (const p of RANK_PRESETS) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "btn secondary";
      b.textContent = p.label;
      b.addEventListener("click", () => loadFromPreset(p));
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

  document.getElementById("btn-save-progress-named")?.addEventListener("click", duplicateProgressAsNamed);

  document.getElementById("btn-delete-progress")?.addEventListener("click", deleteSelectedProgress);

  document.getElementById("btn-export-progress-json")?.addEventListener("click", exportProgressJsonFile);

  document.getElementById("btn-import-progress")?.addEventListener("click", () => {
    document.getElementById("import-progress-file")?.click();
  });

  document.getElementById("import-progress-file")?.addEventListener("change", (e) => {
    const f = e.target.files?.[0];
    if (f) importProgressFromFile(f);
    e.target.value = "";
  });

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

init();
