/**
 * Song ranker: pairwise ranking (see ranker.js) + Spotify Web API (PKCE).
 */

const { Ranker, createSession, estimateComparisons } = window.SongRanker;

const REDIRECT_PATH = "callback.html";
const AUTH_SCOPES = ["playlist-read-private", "playlist-read-collaborative"].join(" ");

const LS_CLIENT = "song_ranker_spotify_client_id";
const LS_SAVED_RANKINGS = "song_ranker_saved_rankings";
const LS_SESSIONS = "song_ranker_sessions_v2";
const LS_THEME = "song_ranker_theme";
/** Pre-v2 in-progress keys, migrated into LS_SESSIONS on startup. */
const LS_LEGACY_AUTOSAVE = "song_ranker_progress_autosave";
const LS_LEGACY_NAMED = "song_ranker_progress_named";
/** `{prefix}{artistId}:{albums|all}` → JSON { v, savedAt, tracks } */
const LS_ARTIST_CACHE_PREFIX = "song_ranker_artist_cache_v2:";
const ARTIST_CACHE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const SS_VERIFIER = "song_ranker_pkce_verifier";
const SS_TOKEN = "song_ranker_access_token";
const SS_EXPIRES = "song_ranker_token_expires_at";
const SS_REFRESH = "song_ranker_refresh_token";

/** Curated quick-start artists: { id, label }. */
const RANK_PRESETS = [{ id: "5K4W6rqBFWDnAN6FQUkS6x", label: "Kanye West" }];

const isLocalDev =
  location.protocol === "file:" || ["localhost", "127.0.0.1", "[::1]"].includes(location.hostname);

/* ------------------------------------------------------------------ */
/* Small helpers                                                       */
/* ------------------------------------------------------------------ */

const $ = (id) => document.getElementById(id);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function setStatus(el, text, isError = false) {
  if (!el) return;
  el.textContent = text || "";
  el.classList.toggle("error", !!isError);
}

function readJson(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

function newId() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return `s-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

/** Only allow links to Spotify (or plain https) — saved data and share links are untrusted. */
function safeHref(url) {
  try {
    const u = new URL(url);
    return u.protocol === "https:" ? u.href : null;
  } catch {
    return null;
  }
}

function downloadTextFile(filename, text, mime) {
  const blob = new Blob([text], { type: mime });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
}

function formatDate(ts) {
  return new Date(ts).toLocaleDateString(undefined, { dateStyle: "medium" });
}

function plural(n, word) {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/* ------------------------------------------------------------------ */
/* Spotify auth (PKCE)                                                 */
/* ------------------------------------------------------------------ */

function basePath() {
  const p = location.pathname;
  if (p.endsWith("/")) return p;
  return p.replace(/\/[^/]+$/, "/") || "/";
}

function redirectUri() {
  if (location.protocol === "file:" || !location.host) {
    return `http://127.0.0.1:8765/${REDIRECT_PATH}`;
  }
  return `${location.protocol}//${location.host}${basePath()}${REDIRECT_PATH}`;
}

function base64urlEncode(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function generatePkce() {
  const verifier = base64urlEncode(crypto.getRandomValues(new Uint8Array(32)));
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return { verifier, challenge: base64urlEncode(digest) };
}

function getStoredClientId() {
  return localStorage.getItem(LS_CLIENT) || "";
}

function getBakedClientId() {
  return (typeof window.SONG_RANKER_CLIENT_ID === "string" ? window.SONG_RANKER_CLIENT_ID : "").trim();
}

function getEffectiveClientId() {
  return getStoredClientId().trim() || getBakedClientId();
}

function getAccessToken() {
  const t = sessionStorage.getItem(SS_TOKEN);
  const exp = Number(sessionStorage.getItem(SS_EXPIRES) || 0);
  if (!t || Date.now() > exp - 60_000) return null;
  return t;
}

function hasSpotifySession() {
  return !!getAccessToken() || !!sessionStorage.getItem(SS_REFRESH);
}

function setAccessToken(token, expiresInSec) {
  sessionStorage.setItem(SS_TOKEN, token);
  sessionStorage.setItem(SS_EXPIRES, String(Date.now() + expiresInSec * 1000));
}

function clearTokens() {
  sessionStorage.removeItem(SS_TOKEN);
  sessionStorage.removeItem(SS_EXPIRES);
  sessionStorage.removeItem(SS_REFRESH);
}

let refreshPromise = null;

/**
 * Returns a usable access token, refreshing it when expired (or when `force` is set after a 401).
 * Only a rejected refresh token signs the user out; a network blip just returns null.
 */
async function getValidAccessToken(force = false) {
  if (!force) {
    const t = getAccessToken();
    if (t) return t;
  }
  const rt = sessionStorage.getItem(SS_REFRESH);
  const clientId = getEffectiveClientId();
  if (!rt || !clientId) return null;
  if (refreshPromise) return refreshPromise;
  refreshPromise = (async () => {
    try {
      const res = await fetch("https://accounts.spotify.com/api/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: rt, client_id: clientId }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (res.status === 400 || res.status === 401) clearTokens();
        return null;
      }
      setAccessToken(data.access_token, data.expires_in || 3600);
      if (data.refresh_token) sessionStorage.setItem(SS_REFRESH, data.refresh_token);
      return data.access_token;
    } catch {
      return null;
    } finally {
      refreshPromise = null;
    }
  })();
  return refreshPromise;
}

async function startLogin() {
  const clientId = getEffectiveClientId();
  if (!clientId) {
    setStatus($("auth-status"), "No Spotify Client ID configured. Set it in config.public.js.", true);
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
  location.href = auth.toString();
}

async function handleAuthReturn() {
  const params = new URLSearchParams(location.search);
  const code = params.get("code");
  const err = params.get("error");
  const authStatus = $("auth-status");
  if (!code && !err) return;
  history.replaceState({}, "", location.pathname);
  if (err) {
    setStatus(authStatus, `Spotify sign-in didn’t finish: ${params.get("error_description") || err}`, true);
    return;
  }
  const verifier = sessionStorage.getItem(SS_VERIFIER);
  const clientId = getEffectiveClientId();
  if (!verifier || !clientId) {
    setStatus(authStatus, "Sign-in expired. Please try again.", true);
    return;
  }
  try {
    const res = await fetch("https://accounts.spotify.com/api/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri(),
        client_id: clientId,
        code_verifier: verifier,
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error_description || data.error || "Token exchange failed");
    setAccessToken(data.access_token, data.expires_in || 3600);
    if (data.refresh_token) sessionStorage.setItem(SS_REFRESH, data.refresh_token);
    sessionStorage.removeItem(SS_VERIFIER);
    setStatus(authStatus, "");
  } catch (e) {
    setStatus(authStatus, e.message || String(e), true);
  }
}

function signOutSpotify() {
  clearTokens();
  updateAuthUi();
  setStatus($("auth-status"), "Signed out.");
}

async function updateAuthUi() {
  const signedIn = hasSpotifySession();
  $("btn-login").classList.toggle("hidden", signedIn);
  $("btn-logout-spotify").classList.toggle("hidden", !signedIn);
  $("signin-card").classList.toggle("hidden", signedIn);
  $("new-section").classList.toggle("hidden", !signedIn && !readyLoad);
  updateLoadButtonState();
  const userEl = $("user-display");
  if (!signedIn) {
    userEl.classList.add("hidden");
    userEl.textContent = "";
    return;
  }
  try {
    const me = await api("/me");
    userEl.textContent = me.display_name || me.id || "Signed in";
  } catch {
    userEl.textContent = hasSpotifySession() ? "Signed in" : "";
  }
  userEl.classList.toggle("hidden", !userEl.textContent);
}

/* ------------------------------------------------------------------ */
/* Spotify Web API                                                     */
/* ------------------------------------------------------------------ */

/** Gap between paginated calls, to stay under Spotify's rolling rate limit. */
const SPOTIFY_GAP_MS = 120;
/** Wait automatically for Retry-After up to this long; beyond it, stop and tell the user. */
const MAX_AUTO_WAIT_SEC = 20;
const MAX_429_RETRIES = 3;

let spotifyCooldownUntil = 0;
let countdownTimer = null;

function clearCountdown() {
  if (countdownTimer) clearInterval(countdownTimer);
  countdownTimer = null;
}

/** Shows a live "try again in Ns" message in the load status line. */
function showCountdown(seconds, template, doneText) {
  clearCountdown();
  const el = $("load-status");
  const end = Date.now() + seconds * 1000;
  const render = () => {
    const left = Math.ceil((end - Date.now()) / 1000);
    if (left <= 0) {
      clearCountdown();
      if (doneText != null) setStatus(el, doneText);
      return;
    }
    setStatus(el, template.replace("{s}", left), true);
  };
  render();
  countdownTimer = setInterval(render, 1000);
}

function parseRetryAfterSeconds(raw) {
  if (raw == null || raw === "") return null;
  const t = String(raw).trim();
  if (/^\d+(\.\d+)?$/.test(t)) return Math.max(1, parseFloat(t));
  const ms = Date.parse(t);
  if (!Number.isNaN(ms)) return Math.max(1, Math.ceil((ms - Date.now()) / 1000));
  return null;
}

function rateLimitError(seconds) {
  const err = new Error("Spotify is rate limiting this app.");
  err.code = "SPOTIFY_429";
  err.retryAfterSeconds = Math.ceil(seconds);
  return err;
}

function spotifyErrorDetail(body) {
  const e = body?.error;
  if (typeof e === "string") return e;
  if (typeof e?.message === "string") return e.message;
  return "";
}

async function api(pathOrUrl) {
  const url = pathOrUrl.startsWith("http") ? pathOrUrl : `https://api.spotify.com/v1${pathOrUrl}`;
  let token = await getValidAccessToken();
  if (!token) throw new Error("Please sign in with Spotify again.");

  const cooldown = (spotifyCooldownUntil - Date.now()) / 1000;
  if (cooldown > MAX_AUTO_WAIT_SEC) throw rateLimitError(cooldown);
  if (cooldown > 0) await sleep(cooldown * 1000);

  let retried401 = false;
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (res.status === 401 && !retried401) {
      retried401 = true;
      token = await getValidAccessToken(true);
      if (token) continue;
    }
    if (res.status === 401) {
      clearTokens();
      updateAuthUi();
      throw new Error("Your Spotify session expired. Please sign in again.");
    }
    if (res.status === 429) {
      await res.text().catch(() => {});
      const sec = parseRetryAfterSeconds(res.headers.get("Retry-After")) ?? 3 + attempt * 4;
      spotifyCooldownUntil = Date.now() + sec * 1000;
      if (sec > MAX_AUTO_WAIT_SEC || attempt >= MAX_429_RETRIES) throw rateLimitError(sec);
      showCountdown(sec, "Spotify asked us to slow down. Continuing in {s}s…", null);
      await sleep(sec * 1000 + Math.random() * 400);
      clearCountdown();
      continue;
    }
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      const detail = spotifyErrorDetail(body) || `${res.status} ${res.statusText}`;
      if (res.status === 403) {
        throw new Error(
          `Spotify refused the request (${detail}). If this is a new device or account, it may need to be added to the app’s user list in the Spotify developer dashboard.`
        );
      }
      if (res.status === 404) throw new Error("Spotify couldn’t find that. Check the link and try again.");
      throw new Error(`Spotify error: ${detail}`);
    }
    return res.json();
  }
}

function parseSpotifyInput(input) {
  const s = (input || "").trim();
  const m =
    s.match(/spotify\.com\/(?:intl-[a-z-]+\/)?(playlist|artist|album|track)\/([a-zA-Z0-9]+)/) ||
    s.match(/^spotify:(playlist|artist|album|track):([a-zA-Z0-9]+)$/);
  return m ? { type: m[1], id: m[2] } : null;
}

function pickImage(images) {
  if (!Array.isArray(images) || !images.length) return null;
  // Spotify returns largest first (640, 300, 64); 300 is plenty for cards.
  return (images[1] || images[0]).url || null;
}

function makeTrack(t, album) {
  return {
    id: t.id,
    name: t.name,
    artists: (t.artists || []).map((a) => a.name).join(", "),
    album: album?.name || "",
    image: pickImage(album?.images),
    url: t.external_urls?.spotify || `https://open.spotify.com/track/${t.id}`,
  };
}

/**
 * Title used to spot the same song released several times (single + album, deluxe,
 * remaster, clean/explicit). Remixes, live and acoustic versions stay distinct.
 */
function normalizeTitle(name) {
  const noise = /\b(feat\.?|ft\.?|featuring|with|remaster(ed)?|\d{4} remaster(ed)?|single version|album version|radio edit|explicit|clean|mono|stereo|bonus track)\b/i;
  return String(name || "")
    .toLowerCase()
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/\s*[([][^)\]]*[)\]]/g, (m) => (noise.test(m) ? "" : m))
    .replace(/\s+-\s+.*$/, (m) => (noise.test(m) ? "" : m))
    .replace(/\s+/g, " ")
    .trim();
}

/** Drops repeat IDs and repeat releases of the same song; the first one seen wins. */
function dedupeSongs(tracks) {
  const seenIds = new Set();
  const seenSongs = new Set();
  const out = [];
  for (const t of tracks) {
    if (!t?.id || seenIds.has(t.id)) continue;
    seenIds.add(t.id);
    const mainArtist = (t.artists || "").split(",")[0].trim().toLowerCase();
    const key = `${normalizeTitle(t.name)}|${mainArtist}`;
    if (seenSongs.has(key)) continue;
    seenSongs.add(key);
    out.push(t);
  }
  return out;
}

async function fetchPaged(firstUrl, onPage) {
  let next = firstUrl;
  let first = true;
  while (next) {
    if (!first) await sleep(SPOTIFY_GAP_MS);
    first = false;
    const data = await api(next);
    onPage(data.items || []);
    next = data.next;
  }
}

async function fetchPlaylist(playlistId, onProgress) {
  const meta = await api(`/playlists/${encodeURIComponent(playlistId)}?fields=name,images`);
  const out = [];
  await fetchPaged(`/playlists/${encodeURIComponent(playlistId)}/items?limit=50`, (items) => {
    for (const item of items) {
      const t = item.track || item.item;
      if (!t || !t.id || t.type === "episode") continue;
      out.push(makeTrack(t, t.album));
    }
    onProgress?.(`Loading playlist… ${out.length} songs`);
  });
  return { tracks: dedupeSongs(out), label: meta.name || "Playlist", image: pickImage(meta.images) };
}

async function fetchAlbum(albumId) {
  const meta = await api(`/albums/${encodeURIComponent(albumId)}`);
  const out = [];
  const push = (items) => {
    for (const t of items) out.push(makeTrack(t, meta));
  };
  push(meta.tracks?.items || []);
  if (meta.tracks?.next) await fetchPaged(meta.tracks.next, push);
  return { tracks: dedupeSongs(out), label: meta.name || "Album", image: pickImage(meta.images) };
}

function getArtistCache(key) {
  const data = readJson(LS_ARTIST_CACHE_PREFIX + key, null);
  if (!data || data.v !== 2 || !Array.isArray(data.tracks)) return null;
  if (Date.now() - (data.savedAt || 0) > ARTIST_CACHE_MAX_AGE_MS) {
    localStorage.removeItem(LS_ARTIST_CACHE_PREFIX + key);
    return null;
  }
  return data;
}

function setArtistCache(key, payload) {
  writeJson(LS_ARTIST_CACHE_PREFIX + key, { v: 2, savedAt: Date.now(), ...payload });
}

/**
 * Artist discography: one call per 10 releases, then one per album. Albums are visited
 * oldest-first so the original release of a song wins over later deluxe/compilation copies.
 * Results are cached per artist for 30 days to avoid repeating the crawl.
 */
async function fetchArtist(artistId, includeSingles, onProgress) {
  const cacheKey = `${artistId}:${includeSingles ? "all" : "albums"}`;
  const cached = getArtistCache(cacheKey);
  if (cached) return { tracks: cached.tracks, label: cached.label, image: cached.image, fromCache: true };

  const artist = await api(`/artists/${encodeURIComponent(artistId)}`);
  const groups = includeSingles ? "album,single" : "album";
  const albums = [];
  onProgress?.("Finding albums…");
  await fetchPaged(
    `/artists/${encodeURIComponent(artistId)}/albums?include_groups=${groups}&limit=10`,
    (items) => albums.push(...items)
  );
  const groupRank = { album: 0, single: 1 };
  albums.sort(
    (a, b) =>
      (groupRank[a.album_group || a.album_type] ?? 2) - (groupRank[b.album_group || b.album_type] ?? 2) ||
      String(a.release_date || "").localeCompare(String(b.release_date || ""))
  );

  const out = [];
  for (let i = 0; i < albums.length; i++) {
    const album = albums[i];
    onProgress?.(`Loading albums… ${i + 1} of ${albums.length}`);
    if (i > 0) await sleep(SPOTIFY_GAP_MS);
    await fetchPaged(`/albums/${encodeURIComponent(album.id)}/tracks?limit=50`, (items) => {
      for (const t of items) {
        if ((t.artists || []).some((a) => a.id === artistId)) out.push(makeTrack(t, album));
      }
    });
  }
  const result = { tracks: dedupeSongs(out), label: artist.name || "Artist", image: pickImage(artist.images) };
  setArtistCache(cacheKey, result);
  return result;
}

/* ------------------------------------------------------------------ */
/* Storage: in-progress sessions & finished lists                      */
/* ------------------------------------------------------------------ */

function getSessions() {
  const list = readJson(LS_SESSIONS, []);
  return Array.isArray(list) ? list : [];
}

function setSessions(list) {
  return writeJson(LS_SESSIONS, list);
}

function getSavedRankings() {
  const list = readJson(LS_SAVED_RANKINGS, []);
  return Array.isArray(list) ? list : [];
}

function setSavedRankings(list) {
  return writeJson(LS_SAVED_RANKINGS, list);
}

/** Converts a pre-v2 progress snapshot (preference graph) into a v2 session. */
function sessionFromLegacySnapshot(snap, name) {
  if (!snap || snap.v !== 1 || !Array.isArray(snap.tracks) || snap.tracks.length < 2) return null;
  const tracks = snap.tracks.map(({ previewUrl, ...t }) => t);
  const n = tracks.length;
  const topN = snap.rankingTopN && snap.rankingTopN >= 2 && snap.rankingTopN < n ? snap.rankingTopN : null;
  return {
    id: newId(),
    label: name || snap.sourceLabel || `${n} songs`,
    image: null,
    createdAt: snap.savedAt || Date.now(),
    updatedAt: snap.savedAt || Date.now(),
    tracks,
    state: { v: 2, order: tracks.map((t) => t.id), topN, log: "", legacyAdj: snap.adj || {} },
  };
}

function migrateLegacyProgress() {
  const migrated = [];
  const auto = readJson(LS_LEGACY_AUTOSAVE, null);
  const s = sessionFromLegacySnapshot(auto);
  if (s) migrated.push(s);
  for (const named of readJson(LS_LEGACY_NAMED, []) || []) {
    const ns = sessionFromLegacySnapshot(named?.snapshot, named?.name);
    if (ns) migrated.push(ns);
  }
  if (migrated.length && !setSessions([...getSessions(), ...migrated])) return;
  localStorage.removeItem(LS_LEGACY_AUTOSAVE);
  localStorage.removeItem(LS_LEGACY_NAMED);
}

/* ------------------------------------------------------------------ */
/* Views                                                               */
/* ------------------------------------------------------------------ */

function showView(name) {
  for (const v of ["home", "compare", "results"]) {
    $(`view-${v}`).classList.toggle("hidden", v !== name);
  }
  if (name === "home") {
    renderSessionList();
    renderSavedRankingsList();
  }
  window.scrollTo({ top: 0 });
}

function artNode(src, className) {
  const img = document.createElement("img");
  img.className = className;
  img.alt = "";
  img.loading = "lazy";
  if (src && safeHref(src)) img.src = src;
  else img.classList.add("art-empty");
  return img;
}

function renderSessionList() {
  const sessions = getSessions().sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  const ul = $("session-list");
  ul.replaceChildren();
  $("continue-section").classList.toggle("hidden", sessions.length === 0);
  for (const s of sessions) {
    let progress = { done: 0, total: 0 };
    try {
      progress = new Ranker(structuredClone(s.state)).progress();
    } catch {
      /* corrupt session: still listed so it can be deleted */
    }
    const pct = progress.total ? Math.round((progress.done / progress.total) * 100) : 0;
    const li = document.createElement("li");
    li.className = "session-item";

    const open = document.createElement("button");
    open.type = "button";
    open.className = "session-open";
    open.addEventListener("click", () => resumeSession(s.id));
    open.appendChild(artNode(s.image || s.tracks?.[0]?.image, "session-art"));
    const text = document.createElement("span");
    text.className = "session-text";
    const title = document.createElement("span");
    title.className = "session-title";
    title.textContent = s.label;
    const meta = document.createElement("span");
    meta.className = "session-meta";
    const goal = s.state.topN ? `Top ${s.state.topN} of ${s.tracks.length}` : plural(s.tracks.length, "song");
    meta.textContent = `${goal} · ${progress.done} of ~${progress.total} picks`;
    const downCount = (s.state.log.match(/[dx]/g) || []).length;
    if (downCount) meta.textContent += ` · ${downCount} 👎`;
    const bar = document.createElement("span");
    bar.className = "mini-bar";
    const fill = document.createElement("span");
    fill.style.width = `${pct}%`;
    bar.appendChild(fill);
    text.append(title, meta, bar);
    const cta = document.createElement("span");
    cta.className = "session-cta";
    cta.textContent = "Continue";
    open.append(text, cta);

    const del = document.createElement("button");
    del.type = "button";
    del.className = "icon-btn";
    del.setAttribute("aria-label", `Delete ${s.label}`);
    del.textContent = "✕";
    del.addEventListener("click", () => {
      if (!confirm(`Delete your in-progress ranking “${s.label}”?`)) return;
      setSessions(getSessions().filter((x) => x.id !== s.id));
      renderSessionList();
    });

    li.append(open, del);
    ul.appendChild(li);
  }
}

function renderSavedRankingsList() {
  const list = getSavedRankings().sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0));
  const ul = $("saved-rankings-list");
  ul.replaceChildren();
  $("saved-rankings-empty").classList.toggle("hidden", list.length > 0);
  for (const s of list) {
    const li = document.createElement("li");
    li.className = "saved-item";
    const open = document.createElement("button");
    open.type = "button";
    open.className = "saved-open";
    open.addEventListener("click", () => openSavedRanking(s.id));
    open.appendChild(artNode(s.image || s.tracks?.[0]?.image, "saved-art"));
    const text = document.createElement("span");
    text.className = "session-text";
    const title = document.createElement("span");
    title.className = "session-title";
    title.textContent = (s.name || "Untitled").slice(0, 120);
    const meta = document.createElement("span");
    meta.className = "session-meta";
    const n = s.tracks?.length ?? 0;
    const top = s.topN ? `Top ${n}` : plural(n, "song");
    const lead = s.tracks?.[0]?.name ? ` · #1 ${s.tracks[0].name}` : "";
    meta.textContent = `${top}${s.savedAt ? ` · ${formatDate(s.savedAt)}` : ""}${lead}`;
    text.append(title, meta);
    open.appendChild(text);

    const del = document.createElement("button");
    del.type = "button";
    del.className = "icon-btn";
    del.setAttribute("aria-label", `Delete ${s.name || "list"}`);
    del.textContent = "✕";
    del.addEventListener("click", () => {
      if (!confirm(`Delete “${s.name || "this list"}” from this device?`)) return;
      setSavedRankings(getSavedRankings().filter((x) => x.id !== s.id));
      renderSavedRankingsList();
    });
    li.append(open, del);
    ul.appendChild(li);
  }
}

/* ------------------------------------------------------------------ */
/* Loading songs                                                       */
/* ------------------------------------------------------------------ */

/** Loaded but not yet started: { tracks, label, image }. */
let readyLoad = null;
let loadInFlight = false;

function updateLoadButtonState() {
  const hasUrl = ($("spotify-url").value || "").trim().length > 0;
  $("btn-load").disabled = loadInFlight || !hasSpotifySession() || !hasUrl;
  document.querySelectorAll(".btn-preset").forEach((b) => {
    b.disabled = loadInFlight || !hasSpotifySession();
  });
}

async function loadSource(kind, id) {
  const status = $("load-status");
  clearCountdown();
  setStatus(status, "Loading…");
  loadInFlight = true;
  updateLoadButtonState();
  const includeSingles = $("include-singles").checked;
  const onProgress = (msg) => setStatus(status, msg);
  try {
    let loaded;
    if (kind === "playlist") loaded = await fetchPlaylist(id, onProgress);
    else if (kind === "album") loaded = await fetchAlbum(id);
    else if (kind === "artist") loaded = await fetchArtist(id, includeSingles, onProgress);
    else if (kind === "track") throw new Error("That’s a single song. Paste a playlist, album or artist link instead.");
    else throw new Error("Unsupported link type.");
    if (loaded.tracks.length < 2) throw new Error("Need at least two songs to rank.");
    setStatus(status, "");
    showReady(loaded);
  } catch (e) {
    if (e?.code === "SPOTIFY_429") {
      showCountdown(
        e.retryAfterSeconds,
        "Spotify is rate limiting this app. Try again in {s}s. Albums and playlists need far fewer requests than whole artists.",
        "You can try loading again now."
      );
    } else {
      setStatus(status, e.message || String(e), true);
    }
  } finally {
    loadInFlight = false;
    updateLoadButtonState();
  }
}

function showReady(loaded) {
  readyLoad = loaded;
  const n = loaded.tracks.length;
  $("new-section").classList.remove("hidden");
  $("load-form").classList.add("hidden");
  $("ready-card").classList.remove("hidden");
  const art = $("ready-art");
  const src = loaded.image || loaded.tracks[0]?.image;
  art.classList.toggle("hidden", !src);
  if (src) art.src = src;
  $("ready-title").textContent = loaded.label;
  $("ready-meta").textContent = `${plural(n, "song")} loaded${loaded.fromCache ? " (saved on this device)" : ""}. How far do you want to go?`;

  const wrap = $("goal-buttons");
  wrap.replaceChildren();
  const goals = [{ topN: null, title: `Rank all ${n}` }];
  // Only offer a top-N goal when it saves a meaningful number of picks.
  const full = estimateComparisons(n, null);
  for (const topN of [25, 100]) {
    if (n > topN && estimateComparisons(n, topN) < full * 0.8) {
      goals.push({ topN, title: `Find my top ${topN}` });
    }
  }
  for (const g of goals) {
    const picks = estimateComparisons(n, g.topN);
    const b = document.createElement("button");
    b.type = "button";
    b.className = `goal-btn${g.topN == null ? " goal-primary" : ""}`;
    const t = document.createElement("span");
    t.className = "goal-title";
    t.textContent = g.title;
    const m = document.createElement("span");
    m.className = "goal-meta";
    m.textContent = `about ${picks} picks · ~${Math.max(1, Math.round((picks * 4) / 60))} min`;
    b.append(t, m);
    b.addEventListener("click", () => startNewSession(loaded, g.topN));
    wrap.appendChild(b);
  }
}

function hideReady() {
  readyLoad = null;
  $("ready-card").classList.add("hidden");
  $("load-form").classList.remove("hidden");
  $("new-section").classList.toggle("hidden", !hasSpotifySession());
}

/* ------------------------------------------------------------------ */
/* Ranking                                                             */
/* ------------------------------------------------------------------ */

/** The ranking on screen: { session, ranker, byId }. */
let active = null;
let saveTimer = null;

function startNewSession(loaded, topN) {
  const state = createSession(
    loaded.tracks.map((t) => t.id),
    topN
  );
  const session = {
    id: newId(),
    label: loaded.label,
    image: loaded.image || null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    tracks: loaded.tracks,
    state,
  };
  if (!setSessions([...getSessions(), session])) {
    setStatus($("load-status"), "Couldn’t save on this device (storage full or blocked). Progress won’t be kept.", true);
  }
  hideReady();
  $("spotify-url").value = "";
  openSession(session);
}

function resumeSession(id) {
  const s = getSessions().find((x) => x.id === id);
  if (s) openSession(s);
}

function openSession(session) {
  active = {
    session,
    ranker: new Ranker(session.state),
    byId: new Map(session.tracks.map((t) => [t.id, t])),
  };
  $("compare-label").textContent = session.state.topN
    ? `${session.label} · top ${session.state.topN}`
    : session.label;
  showView("compare");
  renderCompare();
}

function persistActive(immediate = false) {
  if (!active) return;
  const write = () => {
    saveTimer = null;
    if (!active) return;
    active.session.updatedAt = Date.now();
    const list = getSessions().filter((x) => x.id !== active.session.id);
    list.push(active.session);
    setSessions(list);
  };
  if (saveTimer) clearTimeout(saveTimer);
  if (immediate) write();
  else saveTimer = setTimeout(write, 250);
}

function fillCard(side, track) {
  $(`title-${side}`).textContent = track?.name || "Unknown song";
  $(`meta-${side}`).textContent = [track?.artists, track?.album].filter(Boolean).join(" · ");
  $(`card-${side}`).setAttribute("aria-label", `Choose ${track?.name || "this song"}`);
  const img = $(`art-${side}`);
  const src = track?.image && safeHref(track.image);
  img.classList.toggle("art-empty", !src);
  if (src) img.src = src;
  else img.removeAttribute("src");
  const slot = $(`embed-${side}`);
  slot.replaceChildren();
  const btn = $(`preview-${side}`);
  btn.textContent = "▶ Preview";
  btn.setAttribute("aria-expanded", "false");
  btn.classList.toggle("hidden", !/^[A-Za-z0-9]+$/.test(track?.id || ""));
  $(`down-${side}`).setAttribute("aria-label", `Send ${track?.name || "this song"} to the bottom`);
}

function togglePreview(side) {
  const pair = active?.ranker.currentPair();
  if (!pair) return;
  const track = active.byId.get(side === "left" ? pair.left : pair.right);
  const slot = $(`embed-${side}`);
  const btn = $(`preview-${side}`);
  if (slot.firstChild) {
    slot.replaceChildren();
    btn.textContent = "▶ Preview";
    btn.setAttribute("aria-expanded", "false");
    return;
  }
  const iframe = document.createElement("iframe");
  iframe.className = "spotify-embed";
  iframe.title = `Spotify player: ${track.name}`;
  iframe.height = "80";
  iframe.allow = "autoplay; clipboard-write; encrypted-media";
  iframe.src = `https://open.spotify.com/embed/track/${encodeURIComponent(track.id)}?utm_source=generator&theme=0`;
  slot.appendChild(iframe);
  btn.textContent = "Hide player";
  btn.setAttribute("aria-expanded", "true");
}

function renderCompare() {
  if (!active) return;
  const { ranker } = active;
  if (ranker.isDone()) {
    finishActive();
    return;
  }
  const pair = ranker.currentPair();
  fillCard("left", active.byId.get(pair.left));
  fillCard("right", active.byId.get(pair.right));
  const p = ranker.progress();
  const pct = p.total ? Math.min(100, (p.done / p.total) * 100) : 0;
  $("progress-fill").style.width = `${pct}%`;
  const mins = Math.round((p.remaining * 4) / 60);
  $("progress-text").textContent = `${p.done} of ~${p.total} picks${mins >= 1 ? ` · about ${mins} min left` : " · almost done"}`;
  $("btn-undo").disabled = !ranker.canUndo();
  $("btn-skip-pair").classList.toggle("hidden", !ranker.canSkip());
}

function choose(side) {
  if (!active || active.ranker.isDone()) return;
  const pair = active.ranker.currentPair();
  active.ranker.choose(side === "left" ? pair.left : pair.right);
  setStatus($("compare-status"), "");
  persistActive();
  pulse(side);
  renderCompare();
}

function pulse(side) {
  const card = $(`card-${side}`);
  card.classList.remove("picked");
  void card.offsetWidth;
  card.classList.add("picked");
}

function skipPair() {
  if (!active?.ranker.canSkip()) return;
  active.ranker.skip();
  persistActive();
  renderCompare();
}

function downvote(side) {
  if (!active || active.ranker.isDone()) return;
  const pair = active.ranker.currentPair();
  const id = side === "left" ? pair.left : pair.right;
  active.ranker.downvote(id);
  persistActive();
  const name = active.byId.get(id)?.name || "Song";
  setStatus($("compare-status"), `👎 “${name}” sent to the bottom. Press Undo to bring it back.`);
  renderCompare();
}

function undoPick() {
  if (!active?.ranker.canUndo()) return;
  active.ranker.undo();
  setStatus($("compare-status"), "");
  persistActive();
  renderCompare();
}

function leaveCompare() {
  persistActive(true);
  active = null;
  showView("home");
}

function finishActive() {
  const { session, ranker, byId } = active;
  const topN = session.state.topN;
  const ranked = ranker.result().map((id) => byId.get(id)).filter(Boolean);
  // Downvoted songs go last (most recently downvoted at the very bottom); a top-N list leaves them out.
  if (!topN) {
    for (const id of ranker.downvoted()) {
      const t = byId.get(id);
      if (t) ranked.push({ ...t, downvoted: true });
    }
  }
  const entry = {
    id: newId(),
    name: `${session.label} — ${formatDate(Date.now())}`,
    sourceLabel: session.label,
    image: session.image || null,
    savedAt: Date.now(),
    topN: topN || null,
    tracks: ranked,
  };
  // Keep the full song list for top-N results so "Rank again" can start from everything.
  if (topN) entry.sourceTracks = session.tracks;
  setSavedRankings([...getSavedRankings(), entry]);
  setSessions(getSessions().filter((x) => x.id !== session.id));
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = null;
  active = null;
  showResults(entry, `Saved to Finished lists.`);
}

/* ------------------------------------------------------------------ */
/* Results                                                             */
/* ------------------------------------------------------------------ */

/** Finished list on screen (an entry from LS_SAVED_RANKINGS). */
let currentResult = null;

function openSavedRanking(id) {
  const found = getSavedRankings().find((s) => s.id === id);
  if (found?.tracks?.length) showResults(found, "");
}

function showResults(entry, statusText) {
  currentResult = entry;
  $("save-name").value = entry.name || "";
  const n = entry.tracks.length;
  const of = entry.sourceTracks?.length;
  $("results-meta").textContent = [
    entry.topN && of ? `Top ${n} of ${of} songs` : plural(n, "song"),
    entry.tracks.some((t) => t.downvoted) ? `${entry.tracks.filter((t) => t.downvoted).length} 👎` : "",
    entry.savedAt ? `ranked ${formatDate(entry.savedAt)}` : "",
  ]
    .filter(Boolean)
    .join(" · ");
  setStatus($("share-status"), statusText);
  $("export-menu").open = false;
  renderRankedList(entry.tracks);
  showView("results");
}

function renderRankedList(ranked) {
  const ol = $("ranked-list");
  ol.replaceChildren();
  let dividerShown = false;
  ranked.forEach((t, idx) => {
    if (t.downvoted && !dividerShown) {
      dividerShown = true;
      const div = document.createElement("li");
      div.className = "ranked-divider";
      div.textContent = "Sent to the bottom 👎";
      ol.appendChild(div);
    }
    const li = document.createElement("li");
    li.className =
      idx < 3 && !t.downvoted ? `ranked-item podium podium-${idx + 1}` : "ranked-item";
    if (t.downvoted) li.classList.add("is-downvoted");
    const num = document.createElement("span");
    num.className = "rank-num";
    num.textContent = String(idx + 1);
    const text = document.createElement("span");
    text.className = "rank-text";
    const href = safeHref(t.url);
    const title = document.createElement(href ? "a" : "span");
    title.className = "rank-title";
    title.textContent = t.name;
    if (href) {
      title.href = href;
      title.target = "_blank";
      title.rel = "noopener";
    }
    const meta = document.createElement("span");
    meta.className = "rank-meta";
    meta.textContent = [t.artists, t.album].filter(Boolean).join(" · ");
    text.append(title, meta);
    li.append(num, artNode(t.image, "rank-art"), text);
    ol.appendChild(li);
  });
}

function renameCurrentResult() {
  if (!currentResult) return;
  const name = $("save-name").value.trim() || currentResult.sourceLabel || "Untitled";
  currentResult.name = name;
  setSavedRankings(getSavedRankings().map((s) => (s.id === currentResult.id ? { ...s, name } : s)));
}

function buildSharePayload() {
  if (!currentResult) return null;
  const r = currentResult;
  return {
    v: 1,
    title: String(r.name || r.sourceLabel || "Song ranking").slice(0, 200),
    createdAt: r.savedAt || Date.now(),
    goal: r.topN ? `top${r.topN}` : "full",
    tracks: r.tracks.map((t, i) => ({
      rank: i + 1,
      name: t.name,
      artists: t.artists || "",
      album: t.album || "",
      url: t.url || "",
    })),
  };
}

function encodeSharePayload(obj) {
  const bytes = new TextEncoder().encode(JSON.stringify(obj));
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function copyShareLink() {
  const el = $("share-status");
  const payload = buildSharePayload();
  if (!payload) return;
  const url = `${new URL("viewer.html", location.href).href}#d=${encodeSharePayload(payload)}`;
  if (url.length > 48000) {
    setStatus(el, "This list is too long for a link. Use Export → Download web page instead.");
    return;
  }
  try {
    await navigator.clipboard.writeText(url);
    setStatus(el, "Link copied. Anyone can open it, no Spotify needed.");
  } catch {
    setStatus(el, "Couldn’t copy. Try Export → Download web page.", true);
  }
}

async function downloadSharePage() {
  const el = $("share-status");
  const payload = buildSharePayload();
  if (!payload) return;
  const inject = `<script type="application/json" id="sr-data">${JSON.stringify(payload).replace(/</g, "\\u003c")}<\/script>\n`;
  try {
    const res = await fetch(new URL("viewer.html", location.href));
    if (!res.ok) throw new Error("fetch");
    const html = (await res.text()).replace("<head>", `<head>\n${inject}`);
    downloadTextFile(`song-ranking-${Date.now()}.html`, html, "text/html;charset=utf-8");
    setStatus(el, "Downloaded. The file works offline.");
  } catch {
    setStatus(el, "Couldn’t build the page. Open the app over http(s), not as a file.", true);
  }
}

function copyAsText() {
  const lines = currentResult.tracks.map(
    (t, i) => `${i + 1}. ${t.name}${t.artists ? ` — ${t.artists}` : ""}`
  );
  navigator.clipboard.writeText(lines.join("\n")).then(
    () => setStatus($("share-status"), "Copied to clipboard."),
    () => setStatus($("share-status"), "Couldn’t copy (permission denied).", true)
  );
}

function csvCell(s) {
  const t = s == null ? "" : String(s);
  return /[",\n\r]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
}

function exportCsv() {
  const lines = ["rank,title,artists,album,url"];
  currentResult.tracks.forEach((t, i) => {
    lines.push([i + 1, t.name, t.artists, t.album, t.url].map(csvCell).join(","));
  });
  downloadTextFile(`song-ranking-${Date.now()}.csv`, lines.join("\n"), "text/csv;charset=utf-8");
}

function exportJson() {
  const payload = {
    v: 1,
    type: "song_ranker_result",
    name: currentResult.name,
    exportedAt: new Date().toISOString(),
    tracks: currentResult.tracks,
  };
  downloadTextFile(`song-ranking-${Date.now()}.json`, JSON.stringify(payload, null, 2), "application/json");
}

function rankAgain() {
  if (!currentResult) return;
  const tracks = (currentResult.sourceTracks || currentResult.tracks).map(({ downvoted, ...t }) => t);
  startNewSession(
    { tracks, label: currentResult.sourceLabel || currentResult.name, image: currentResult.image },
    currentResult.topN || null
  );
}

/* ------------------------------------------------------------------ */
/* Online backup (Supabase, optional)                                  */
/* ------------------------------------------------------------------ */

let supabaseClient = null;

function getSyncPayload() {
  return { v: 2, savedRankings: getSavedRankings(), sessions: getSessions() };
}

function applySyncPayload(obj) {
  if (!obj || (obj.v !== 1 && obj.v !== 2)) throw new Error("That online backup isn’t valid.");
  setSavedRankings(Array.isArray(obj.savedRankings) ? obj.savedRankings : []);
  if (obj.v === 2) {
    setSessions(Array.isArray(obj.sessions) ? obj.sessions : []);
  } else {
    const migrated = [];
    if (typeof obj.autosave === "string") {
      const s = sessionFromLegacySnapshot(JSON.parse(obj.autosave));
      if (s) migrated.push(s);
    }
    for (const named of obj.namedProgress || []) {
      const s = sessionFromLegacySnapshot(named?.snapshot, named?.name);
      if (s) migrated.push(s);
    }
    setSessions(migrated);
  }
  renderSessionList();
  renderSavedRankingsList();
}

async function ensureSupabaseSession() {
  let {
    data: { session },
  } = await supabaseClient.auth.getSession();
  if (!session) {
    const { error } = await supabaseClient.auth.signInAnonymously();
    if (error) throw error;
    ({
      data: { session },
    } = await supabaseClient.auth.getSession());
  }
  if (!session?.user?.id) throw new Error("Couldn’t connect to online backup.");
  return session;
}

async function initCloudSync() {
  const url = String(window.SONG_RANKER_SUPABASE_URL || "").trim();
  const key = String(window.SONG_RANKER_SUPABASE_ANON_KEY || "").trim();
  if (!url || !key || location.protocol === "file:") return;
  const statusEl = $("cloud-status");
  const syncBtn = $("btn-cloud-sync");
  const restoreBtn = $("btn-cloud-restore");
  $("cloud-panel").classList.remove("hidden");
  setStatus(statusEl, "Connecting…");
  try {
    const mod = await import("https://esm.sh/@supabase/supabase-js@2.49.1");
    supabaseClient = mod.createClient(url, key, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
    });
    await ensureSupabaseSession();
  } catch (e) {
    console.warn(e);
    setStatus(statusEl, "Online backup isn’t reachable right now.", true);
    return;
  }
  setStatus(statusEl, "Back up your lists and in-progress rankings so you can restore them on another device.");
  syncBtn.disabled = false;
  restoreBtn.disabled = false;

  syncBtn.addEventListener("click", async () => {
    try {
      setStatus(statusEl, "Uploading…");
      const session = await ensureSupabaseSession();
      const { error } = await supabaseClient.from("song_ranker_sync").upsert(
        { user_id: session.user.id, data: getSyncPayload(), updated_at: new Date().toISOString() },
        { onConflict: "user_id" }
      );
      if (error) throw error;
      setStatus(statusEl, "Backed up.");
    } catch (e) {
      setStatus(statusEl, e.message || String(e), true);
    }
  });

  restoreBtn.addEventListener("click", async () => {
    if (!confirm("Replace this device’s lists and in-progress rankings with your online backup?")) return;
    try {
      setStatus(statusEl, "Downloading…");
      await ensureSupabaseSession();
      const { data, error } = await supabaseClient.from("song_ranker_sync").select("data").maybeSingle();
      if (error) throw error;
      if (!data?.data) throw new Error("Nothing backed up yet.");
      applySyncPayload(data.data);
      setStatus(statusEl, "Restored.");
    } catch (e) {
      setStatus(statusEl, e.message || String(e), true);
    }
  });
}

/* ------------------------------------------------------------------ */
/* Theme, keyboard, wiring                                             */
/* ------------------------------------------------------------------ */

function applyTheme(mode) {
  const h = document.documentElement;
  h.classList.remove("theme-dark", "theme-light", "theme-auto");
  h.classList.add(mode === "light" ? "theme-light" : mode === "auto" ? "theme-auto" : "theme-dark");
}

function initTheme() {
  const sel = $("theme-select");
  const saved = localStorage.getItem(LS_THEME);
  const v = ["light", "dark", "auto"].includes(saved) ? saved : "dark";
  sel.value = v;
  applyTheme(v);
  sel.addEventListener("change", () => {
    localStorage.setItem(LS_THEME, sel.value);
    applyTheme(sel.value);
  });
}

function initKeyboard() {
  document.addEventListener("keydown", (e) => {
    if (!active || $("view-compare").classList.contains("hidden")) return;
    const tag = e.target?.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
    if (e.ctrlKey || e.metaKey || e.altKey || e.repeat) return;
    const k = e.key.toLowerCase();
    if (e.shiftKey && (e.code === "Digit1" || e.key === "ArrowLeft")) downvote("left");
    else if (e.shiftKey && (e.code === "Digit2" || e.key === "ArrowRight")) downvote("right");
    else if (k === "1" || e.key === "ArrowLeft") choose("left");
    else if (k === "2" || e.key === "ArrowRight") choose("right");
    else if (k === "u") undoPick();
    else if (k === "s") skipPair();
    else return;
    e.preventDefault();
  });
}

/** Local-only config.js (gitignored) can override Client ID / Supabase keys during development. */
function loadLocalConfig() {
  if (!isLocalDev) return Promise.resolve();
  return new Promise((resolve) => {
    const s = document.createElement("script");
    s.src = "config.js";
    s.onload = resolve;
    s.onerror = resolve;
    document.head.appendChild(s);
  });
}

function wireUi() {
  $("btn-login").addEventListener("click", startLogin);
  $("btn-login-hero").addEventListener("click", startLogin);
  $("btn-logout-spotify").addEventListener("click", signOutSpotify);

  $("spotify-url").addEventListener("input", updateLoadButtonState);
  $("spotify-url").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !$("btn-load").disabled) $("btn-load").click();
  });
  $("btn-load").addEventListener("click", () => {
    const parsed = parseSpotifyInput($("spotify-url").value);
    if (!parsed) {
      setStatus($("load-status"), "That doesn’t look like a Spotify playlist, album or artist link.", true);
      return;
    }
    loadSource(parsed.type, parsed.id);
  });
  const presetWrap = $("preset-buttons");
  for (const p of RANK_PRESETS) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "btn-preset";
    b.textContent = p.label;
    b.addEventListener("click", () => loadSource("artist", p.id));
    presetWrap.appendChild(b);
  }
  $("btn-ready-cancel").addEventListener("click", hideReady);

  $("card-left").addEventListener("click", () => choose("left"));
  $("card-right").addEventListener("click", () => choose("right"));
  $("preview-left").addEventListener("click", () => togglePreview("left"));
  $("preview-right").addEventListener("click", () => togglePreview("right"));
  $("down-left").addEventListener("click", () => downvote("left"));
  $("down-right").addEventListener("click", () => downvote("right"));
  $("btn-undo").addEventListener("click", undoPick);
  $("btn-skip-pair").addEventListener("click", skipPair);
  $("btn-back-home-compare").addEventListener("click", leaveCompare);

  $("btn-back-home-results").addEventListener("click", () => showView("home"));
  $("btn-new").addEventListener("click", () => {
    showView("home");
    $("spotify-url").focus();
  });
  $("btn-restart").addEventListener("click", rankAgain);
  $("save-name").addEventListener("change", renameCurrentResult);
  $("btn-share-copy-link").addEventListener("click", copyShareLink);
  const closeMenu = () => ($("export-menu").open = false);
  $("btn-export").addEventListener("click", () => (closeMenu(), copyAsText()));
  $("btn-export-csv").addEventListener("click", () => (closeMenu(), exportCsv()));
  $("btn-export-json").addEventListener("click", () => (closeMenu(), exportJson()));
  $("btn-share-download-page").addEventListener("click", () => (closeMenu(), downloadSharePage()));
  document.addEventListener("click", (e) => {
    if (!e.target.closest("#export-menu")) closeMenu();
  });

  window.addEventListener("pagehide", () => persistActive(true));

  if (isLocalDev || !getBakedClientId()) {
    $("dev-setup").classList.remove("hidden");
    $("redirect-uri-display").textContent = redirectUri();
    $("client-id").value = getStoredClientId();
    $("btn-save-client").addEventListener("click", () => {
      const v = $("client-id").value.trim();
      if (v) localStorage.setItem(LS_CLIENT, v);
      else localStorage.removeItem(LS_CLIENT);
      setStatus($("auth-status"), v ? "Client ID saved." : "Client ID override cleared.");
    });
  }
}

async function init() {
  await loadLocalConfig();
  initTheme();
  initKeyboard();
  wireUi();
  migrateLegacyProgress();
  showView("home");
  if (location.protocol === "file:") {
    setStatus(
      $("auth-status"),
      "Open over HTTP, not file://. Try: python3 -m http.server 8765 → http://127.0.0.1:8765/",
      true
    );
  }
  await handleAuthReturn();
  await getValidAccessToken();
  await updateAuthUi();
  initCloudSync().catch((e) => console.warn(e));
}

init().catch((err) => console.error(err));
