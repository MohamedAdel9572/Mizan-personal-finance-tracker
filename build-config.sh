#!/bin/sh
# Same idea as skn-clinic/build-config.sh: the Supabase URL and anon key come from
# environment variables at build time (Vercel → Settings → Environment Variables).
# Accepted names (either pair works):
#   SUPABASE_URL + SUPABASE_KEY                  (same names as skn-clinic)
#   VITE_SUPABASE_URL + VITE_SUPABASE_ANON_KEY   (Vite's own names)
# Vite only exposes variables that start with VITE_, so we write .env.production.local.
#
# Cache-busting from the old script is no longer needed: Vite puts a content hash
# in every asset file name.
set -e

URL="${SUPABASE_URL:-$VITE_SUPABASE_URL}"
KEY="${SUPABASE_KEY:-${VITE_SUPABASE_ANON_KEY:-$SUPABASE_ANON_KEY}}"

if [ -n "$URL" ] && [ -n "$KEY" ]; then
  cat > .env.production.local <<CFG
VITE_SUPABASE_URL=$URL
VITE_SUPABASE_ANON_KEY=$KEY
CFG
  echo "build-config: Supabase settings found (${URL})"
elif [ -f .env.production.local ] || [ -f .env.local ]; then
  echo "build-config: using existing .env file"
else
  echo "build-config: ERROR - Supabase settings missing." >&2
  echo "  Add SUPABASE_URL and SUPABASE_KEY in Vercel > Settings > Environment Variables" >&2
  echo "  (tick Production AND Preview), then redeploy the LATEST commit." >&2
  echo "  Seen: SUPABASE_URL=${SUPABASE_URL:+set} SUPABASE_KEY=${SUPABASE_KEY:+set} VERCEL_ENV=${VERCEL_ENV:-?}" >&2
  exit 1
fi
