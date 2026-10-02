#!/usr/bin/env bash
# Build the image, run it the way compose does (non-root, state volume, bind-mounted vault), and check that it
# becomes healthy, rejects an unauthenticated call, and writes a note that lands in the vault's git history.
set -euo pipefail
export MSYS_NO_PATHCONV=1

# `pwd -W` gives a Windows path under Git Bash, which the native docker needs; Linux and macOS fall back to pwd.
realpath_for_docker() { (cd "$1" && (pwd -W 2>/dev/null || pwd)); }
repo="$(realpath_for_docker "$(dirname "${BASH_SOURCE[0]}")/..")"
work="$(realpath_for_docker "$(mktemp -d)")"
name="lifekernel-smoke-$$"
image="lifekernel:smoke-$$"
token="smoke-token-0123456789abcdefghij"
port="${SMOKE_PORT:-18799}"

cleanup() {
  docker rm -f "$name" >/dev/null 2>&1 || true
  docker volume rm "$name-state" >/dev/null 2>&1 || true
  docker image rm "$image" >/dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT

docker build -q -t "$image" "$repo" >/dev/null

mkdir -p "$work/vaults"
node "$repo/apps/cli/dist/index.js" init "$work/vaults/personal" >/dev/null
(cd "$work/vaults/personal" && git init -q && git add -A && git -c user.name=smoke -c user.email=smoke@example.com commit -q -m init)
node -e '
  const fs = require("fs");
  const config = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  config.vaults[0].history = "git";
  fs.writeFileSync(process.argv[2], JSON.stringify(config));
' "$repo/lifekernel.config.docker.example.json" "$work/lifekernel.config.json"

docker run -d --name "$name" -p "127.0.0.1:$port:8787" --user "$(id -u 2>/dev/null || echo 1000):$(id -g 2>/dev/null || echo 1000)" \
  -e LIFEKERNEL_CONFIG=/config/lifekernel.config.json -e LIFEKERNEL_HOST=0.0.0.0 -e LIFEKERNEL_API_TOKEN="$token" \
  -v "$work/lifekernel.config.json:/config/lifekernel.config.json:ro" -v "$work/vaults:/vaults" -v "$name-state:/state" "$image" >/dev/null

status=""
for _ in $(seq 1 24); do
  status="$(docker inspect -f '{{.State.Health.Status}}' "$name")"
  [ "$status" = "healthy" ] && break
  sleep 5
done
[ "$status" = "healthy" ] || { echo "container never became healthy (status: $status)"; docker logs "$name"; exit 1; }

base="http://127.0.0.1:$port"
# The status code is the last line of the reply; no -o /dev/null, which a native Windows curl cannot open.
code="$(curl -s -w '
%{http_code}' "$base/v1/vaults" | tail -n 1)"
[ "$code" = "401" ] || { echo "an unauthenticated call returned $code, expected 401"; exit 1; }

reply="$(curl -s -H "Authorization: Bearer $token" -H 'content-type: application/json' \
  -d '{"requestId":"docker-smoke-0001","vaultId":"personal","operation":"create","route":"daily","title":"Smoke","body":"Written by the container.","source":"smoke","sourceDate":"2026-10-01"}' \
  "$base/v1/writes/apply")"
echo "$reply" | grep -q '"committed":true' || { echo "the write was not committed to history: $reply"; exit 1; }
(cd "$work/vaults/personal" && git log -1 --format=%s | grep -q 'lifekernel: create daily/2026-10-01.md') || { echo "no history commit in the vault"; exit 1; }

echo "docker smoke ok: healthy, 401 without a token, write committed to git history"
