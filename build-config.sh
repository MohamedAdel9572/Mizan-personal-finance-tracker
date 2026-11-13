#!/bin/sh
# Same idea as skn-clinic/build-config.sh: the Supabase URL and anon key come from
# environment variables at build time (Vercel → Settings → Environment Variables).
# Vite only exposes variables that start with VITE_, so we map the plain names you
# already use (SUPABASE_URL / SUPABASE_KEY) into .env.production.local.
#
# Cache-busting from the old script is no longer needed: Vite puts a content hash
# in every asset file name.
set -e

if [ -n "$SUPABASE_URL" ] && [ -n "$SUPABASE_KEY" ]; then
  cat > .env.production.local <<CFG
VITE_SUPABASE_URL=$SUPABASE_URL
VITE_SUPABASE_ANON_KEY=$SUPABASE_KEY
CFG
  echo "build-config: .env.production.local written from environment variables"
elif [ -f .env.production.local ] || [ -f .env.local ]; then
  echo "build-config: SUPABASE_URL / SUPABASE_KEY not set, using existing .env file"
else
  echo "build-config: ERROR - set SUPABASE_URL and SUPABASE_KEY (Vercel env vars) or create .env.local" >&2
  exit 1
fi
