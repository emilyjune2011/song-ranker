/**
 * Hosting: put your Spotify app Client ID here once. Everyone who opens the site
 * then only clicks "Sign in with Spotify" — they do not need a developer account.
 * Leave empty to type the Client ID in the page instead (good for local testing).
 */
window.SONG_RANKER_CLIENT_ID = "9d7bdf69709748168dea81482e9eeb5e";

/**
 * Optional: cloud backup via Supabase. In the dashboard: run supabase-schema.sql, enable
 * Authentication → Providers → Anonymous, then paste Project URL + anon public key (Settings → API).
 */
window.SONG_RANKER_SUPABASE_URL = "https://gfcdqmcsazsfvfwsqixy.supabase.co";
window.SONG_RANKER_SUPABASE_ANON_KEY =
  "sb_publishable_OgtB8s1Id4C6o0X2ESHhmQ_ZMVhYKIi";
