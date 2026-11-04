#!/bin/sh
# Pull the head unit's software for off-car analysis. Read-only on the unit.
#
#   [SSH_KEY=<private key>] re/pull_unit.sh <unit-host> [<out-dir>]
#
# SSH_KEY is the unit's root key (e.g. an MGU-SSH enrollment's id_rsa). A host
# seen for the first time is added to known_hosts (accept-new).
#
# Writes <out-dir>/facts.txt (unit/facts.sh's output) and <out-dir>/rootfs.tar
# (the root file system, one file system only, no /proc /sys /dev /run /tmp).
# The default <out-dir> is ../idrive-rootfs/<carplay version or host>, outside
# this repository: it holds BMW and Cinemo binaries, which are never committed.
set -eu

HOST=${1:?usage: re/pull_unit.sh <unit-host> [<out-dir>]}
HERE=$(cd "$(dirname "$0")" && pwd)
SSH="ssh -o BatchMode=yes -o ConnectTimeout=10 -o StrictHostKeyChecking=accept-new${SSH_KEY:+ -o IdentitiesOnly=yes -i $SSH_KEY} root@$HOST"

TMP=$(mktemp)
$SSH 'sh -s' < "$HERE/unit/facts.sh" > "$TMP"

if [ -n "${2:-}" ]; then
    OUT=$2
else
    VER=$(grep -aoE 'carplay[ _-]?[0-9]+\.[0-9]+\.[0-9]+' "$TMP" | head -1 | grep -oE '[0-9.]+$' || true)
    OUT="$HERE/../../idrive-rootfs/${VER:-$HOST}"
fi
mkdir -p "$OUT"
mv "$TMP" "$OUT/facts.txt"
echo "facts: $OUT/facts.txt"

# GNU tar knows --one-file-system; busybox tar does not, so list the
# directories instead (the unit's other mounts are listed in facts.txt).
if grep -q 'GNU tar' "$OUT/facts.txt"; then
    REMOTE='cd / && tar -cf - --one-file-system --exclude=./proc --exclude=./sys --exclude=./dev --exclude=./run --exclude=./tmp .'
else
    REMOTE='cd / && tar -cf - $(for d in bin sbin lib lib32 lib64 usr etc opt var/lib; do [ -e "$d" ] && echo "$d"; done)'
fi
echo "pulling the root file system (this can take a while)..."
$SSH "$REMOTE" > "$OUT/rootfs.tar.part"
mv "$OUT/rootfs.tar.part" "$OUT/rootfs.tar"
ls -la "$OUT"
(cd "$OUT" && sha256sum rootfs.tar > rootfs.tar.sha256)
echo "done: $OUT"
