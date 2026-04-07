/**
 * Song ranker: merge-sort pairwise comparisons + Spotify Web API (PKCE).
 */

const REDIRECT_PATH = "callback.html";
const AUTH_SCOPES = [
  "playlist-read-private",
  "playlist-read-collaborative",
].join(" ");

const LS_CLIENT = "song_ranker_spotify_client_id";
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
    throw new Error(err.error?.message || `${res.status} ${res.statusText}`);
  }
  return res.json();
}

async function fetchAllPlaylistTracks(playlistId) {
  const out = [];
  let url = `/playlists/${encodeURIComponent(playlistId)}/tracks?limit=100`;
  while (url) {
    const data = await api(url);
    for (const item of data.items || []) {
      const t = item.track;
      if (!t || !t.id) continue;
      out.push(normalizeTrack(t));
    }
    url = data.next || null;
  }
  return dedupeById(out);
}

async function fetchAlbumTracks(albumId) {
  const meta = await api(`/albums/${encodeURIComponent(albumId)}`);
  const albumName = meta.name || "";
  const artistsMain = (meta.artists || []).map((a) => a.name).join(", ");
  const out = [];
  let url = `/albums/${encodeURIComponent(albumId)}/tracks?limit=50`;
  while (url) {
    const data = await api(url);
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
    url = data.next || null;
  }
  return dedupeById(out);
}

async function fetchArtistTracks(artistId) {
  const albumNames = new Map();
  const albums = new Set();
  let url = `/artists/${encodeURIComponent(artistId)}/albums?include_groups=album,single&limit=50`;
  while (url) {
    const data = await api(url);
    for (const a of data.items || []) {
      albums.add(a.id);
      albumNames.set(a.id, a.name);
    }
    url = data.next || null;
  }

  const out = [];
  for (const albumId of albums) {
    let tUrl = `/albums/${encodeURIComponent(albumId)}/tracks?limit=50`;
    while (tUrl) {
      const data = await api(tUrl);
      for (const t of data.items || []) {
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
      tUrl = data.next || null;
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

function parseManualList(text) {
  const lines = text.split(/\n/).map((l) => l.trim()).filter(Boolean);
  const out = [];
  for (const line of lines) {
    let namePart = line;
    let url = "";
    const pipe = line.lastIndexOf("|");
    if (pipe !== -1) {
      namePart = line.slice(0, pipe).trim();
      url = line.slice(pipe + 1).trim();
    }
    const m = url.match(/track\/([a-zA-Z0-9]+)/);
    const id = m ? m[1] : `manual-${out.length}`;
    const name = namePart || "Unknown";
    out.push({
      id,
      name,
      artists: "",
      album: "",
      url: url || "#",
    });
  }
  return out;
}

/** Merge sort using user comparisons; O(n log n) comparisons worst-case. */
async function mergeSortByCompare(arr, compareFn) {
  if (arr.length <= 1) return arr;
  const mid = Math.floor(arr.length / 2);
  const left = await mergeSortByCompare(arr.slice(0, mid), compareFn);
  const right = await mergeSortByCompare(arr.slice(mid), compareFn);
  return merge(left, right, compareFn);
}

async function merge(left, right, compareFn) {
  const result = [];
  let i = 0;
  let j = 0;
  while (i < left.length && j < right.length) {
    const cmp = await compareFn(left[i], right[j]);
    if (cmp <= 0) result.push(left[i++]);
    else result.push(right[j++]);
  }
  return result.concat(left.slice(i)).concat(right.slice(j));
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
    ? `Comparison ${compareStep} of ~${compareEstimate} (rough upper bound; actual merges may finish sooner)`
    : "";
}

function showComparePanel(show) {
  document.getElementById("panel-setup")?.classList.toggle("hidden", show);
  document.getElementById("panel-compare")?.classList.toggle("hidden", !show);
}

function showResultsPanel(show) {
  document.getElementById("panel-results")?.classList.toggle("hidden", !show);
}

function renderPair(a, b) {
  document.getElementById("title-a").textContent = a.name;
  document.getElementById("meta-a").textContent = [a.artists, a.album].filter(Boolean).join(" · ");
  document.getElementById("title-b").textContent = b.name;
  document.getElementById("meta-b").textContent = [b.artists, b.album].filter(Boolean).join(" · ");
  const la = document.getElementById("link-a");
  const lb = document.getElementById("link-b");
  la.href = a.url;
  lb.href = b.url;
}

function compareTracks(a, b) {
  return new Promise((resolve) => {
    pendingResolve = resolve;
    compareStep += 1;
    updateProgress();
    renderPair(a, b);
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
}

async function runRanking(tracks) {
  if (tracks.length === 0) return;
  compareStep = 0;
  compareEstimate = estimateMergeComparisons(tracks.length);
  updateProgress();
  showComparePanel(true);
  showResultsPanel(false);

  const ranked = await mergeSortByCompare(tracks, async (a, b) => {
    if (a.id === b.id) return 0;
    return compareTracks(a, b);
  });

  showComparePanel(false);
  showResultsPanel(true);
  const ol = document.getElementById("ranked-list");
  ol.innerHTML = "";
  ranked.forEach((t, idx) => {
    const li = document.createElement("li");
    const a = document.createElement("a");
    a.href = t.url;
    a.target = "_blank";
    a.rel = "noopener";
    a.textContent = `${idx + 1}. ${t.name}${t.artists ? ` — ${t.artists}` : ""}`;
    li.appendChild(a);
    ol.appendChild(li);
  });

  window.__lastRanked = ranked;
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
    document.getElementById("auth-status").textContent = "Signed in.";
    document.getElementById("auth-status").classList.remove("error");
    document.getElementById("btn-load").disabled = false;
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
    document.getElementById("auth-status").textContent = "Signed in.";
    document.getElementById("btn-load").disabled = false;
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
      await runRanking(tracks);
    } catch (e) {
      status.textContent = e.message || String(e);
      status.classList.add("error");
    }
  });

  document.getElementById("btn-manual")?.addEventListener("click", async () => {
    const text = document.getElementById("manual-tracks").value;
    const status = document.getElementById("load-status");
    status.textContent = "";
    status.classList.remove("error");
    const tracks = parseManualList(text);
    if (tracks.length < 2) {
      status.textContent = "Add at least two lines with a Spotify track URL after |.";
      status.classList.add("error");
      return;
    }
    status.textContent = `Using ${tracks.length} manual tracks.`;
    await runRanking(tracks);
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

  document.getElementById("btn-restart")?.addEventListener("click", () => {
    const ranked = window.__lastRanked;
    if (!ranked?.length) return;
    runRanking([...ranked]).catch(() => {});
  });

  document.getElementById("btn-new")?.addEventListener("click", () => {
    window.__lastRanked = null;
    showComparePanel(false);
    showResultsPanel(false);
    document.getElementById("panel-setup")?.classList.remove("hidden");
    document.getElementById("load-status").textContent = "";
    document.getElementById("copy-status").textContent = "";
  });
}

init();
