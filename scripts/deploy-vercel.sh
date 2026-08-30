#!/usr/bin/env bash
# ════════════════════════════════════════════════════════════
# DexPort — deploy a Vercel (producción)
# Uso:  VERCEL_TOKEN=<token> ./scripts/deploy-vercel.sh
# (o conecta el repo GitHub al proyecto Vercel → auto-deploy)
# ════════════════════════════════════════════════════════════
set -euo pipefail
cd "$(dirname "$0")/.."

if [ -z "${VERCEL_TOKEN:-}" ]; then
  echo "ERROR: falta VERCEL_TOKEN (vercel.com → Settings → Tokens)" >&2
  exit 1
fi

npm run build
npx vercel --prod --yes --token "$VERCEL_TOKEN"
echo "✓ Deploy completo — https://dexport-mu.vercel.app"
