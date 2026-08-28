#!/usr/bin/env bash
# VortexGPU deploy: build from a clean git checkout, swap dist/, restart, verify,
# and roll back automatically if the health check fails.
#
#   bash /opt/vortexgpu/deploy.sh            # deploy current HEAD
#   bash /opt/vortexgpu/deploy.sh <commit>   # deploy a specific commit
#
# Rolls back to the previous dist/ if /api/health does not return 200.
set -euo pipefail

APP=/opt/vortexgpu
REF="${1:-HEAD}"
TS=$(date +%Y%m%d-%H%M%S)
BUILD=$(mktemp -d /tmp/vortex-deploy-XXXXXX)
BK="$APP/dist.rollback-$TS"

cleanup() { git -C "$APP" worktree remove --force "$BUILD" 2>/dev/null || true; rm -rf "$BUILD"; }
trap cleanup EXIT

echo "[1/6] checking out $REF into a clean worktree"
git -C "$APP" worktree add -q --detach "$BUILD" "$REF"
SHA=$(git -C "$BUILD" rev-parse --short HEAD)
ln -s "$APP/node_modules" "$BUILD/node_modules"
echo "      building $SHA (working-tree changes are NOT included)"

echo "[2/6] building"
( cd "$BUILD" \
  && npx vite build >/dev/null 2>&1 \
  && npx esbuild server.ts --bundle --platform=node --format=cjs \
       --packages=external --sourcemap --outfile=dist/server.cjs >/dev/null 2>&1 )
test -s "$BUILD/dist/server.cjs" || { echo "BUILD FAILED — nothing changed"; exit 1; }

echo "[3/6] backing up live dist -> $BK"
cp -a "$APP/dist" "$BK"

echo "[4/6] swapping in the new artifact"
rm -rf "$APP/dist.new"
cp -a "$BUILD/dist" "$APP/dist.new"
rm -rf "$APP/dist"
mv "$APP/dist.new" "$APP/dist"

echo "[5/6] restarting (this logs out all active sessions — tokens are in-memory)"
systemctl restart vortexgpu

echo "[6/6] health check"
ok=0
for i in $(seq 1 15); do
  sleep 2
  code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 4 http://127.0.0.1:3000/api/health || echo 000)
  echo "      attempt $i -> $code"
  [ "$code" = "200" ] && { ok=1; break; }
done

if [ "$ok" = "1" ]; then
  echo
  echo "DEPLOYED OK  ($SHA)  backup: $BK"
  systemctl show vortexgpu -p MainPID -p NRestarts
  # Keep the 3 most recent rollback snapshots; drop older ones.
  ls -1dt "$APP"/dist.rollback-* 2>/dev/null | tail -n +4 | while read -r old; do
    echo "      pruning old backup: $old"; rm -rf "$old"
  done
else
  echo
  echo "UNHEALTHY — ROLLING BACK"
  rm -rf "$APP/dist"
  cp -a "$BK" "$APP/dist"
  systemctl restart vortexgpu
  sleep 5
  echo "post-rollback health: $(curl -s -o /dev/null -w '%{http_code}' --max-time 5 http://127.0.0.1:3000/api/health)"
  echo "Logs: journalctl -u vortexgpu -n 50 --no-pager"
  exit 1
fi
