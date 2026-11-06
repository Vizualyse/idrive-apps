#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 Yousaf Khan
#
# Builds what the tool ships besides its scripts (tools/bundle.sh says what
# and why): build/runtime.tgz, build/proton.tgz, build/prefix.tgz,
# build/launch.json, build/bundle-VERSION.txt. In the image from
# image/Dockerfile; the downloads (GE-Proton, .NET, DepotDownloader, checked
# by hash) are kept in the Docker volume steam-build-dl and Proton is unpacked
# only inside the container: never on the Windows drive, where Windows
# Defender removed one of Wine's DLLs (README.md). Kept when its inputs
# haven't changed.
# Run by the packer (component.json "build"), or by hand:
#   sh native/vizualyse-steam/build.sh
set -eu
export MSYS_NO_PATHCONV=1   # Git Bash: leave container paths alone
HERE=$(cd "$(dirname "$0")" && pwd)
WIN_HERE=$(cd "$HERE" && (pwd -W 2>/dev/null || pwd))
IMG=idrive-steam-build:trixie-$(sha256sum "$HERE/image/Dockerfile" | cut -c1-8)
[ "${1:-}" = image-name ] && { echo "$IMG"; exit 0; }
LOG=${TMPDIR:-/tmp}/steam-image.$$.log
if ! docker image inspect $IMG >/dev/null 2>&1; then
    n=1
    # snapshot.debian.org drops downloads now and then: try 3 times
    until docker build --platform linux/amd64 --progress=plain -t $IMG -f "$WIN_HERE/image/Dockerfile" "$WIN_HERE/image" > "$LOG" 2>&1; do
        tail -25 "$LOG" >&2
        [ $n -ge 3 ] && { echo "build.sh: the image did not build in $n tries" >&2; exit 1; }
        n=$((n + 1)); echo "build.sh: image build failed, try $n of 3" >&2; sleep 20
    done
    rm -f "$LOG"
fi
[ "${1:-}" = image ] && exit 0
mkdir -p "$HERE/build"
key=$( (cat "$HERE/image/Dockerfile" "$HERE/tools/bundle.sh" "$HERE"/src/*.c "$HERE"/src/*.h "$HERE"/src/protocol/*; \
        docker image inspect -f '{{.Id}}' $IMG) | sha256sum | cut -c1-16)
if [ -f "$HERE/build/proton.tgz" ] && [ -f "$HERE/build/launch.json" ] && [ "$(cat "$HERE/build/bundle.key" 2>/dev/null)" = "$key" ]; then
    echo "vizualyse-steam bundles: up to date ($key)"
    exit 0
fi
rm -f "$HERE/build/bundle.key"
# a fixed host name: Wine keeps it in the prefix as the computer's name
docker run --rm --platform linux/amd64 --shm-size=512m --hostname vizualyse -v "$WIN_HERE:/m" -v steam-build-dl:/dl $IMG sh /m/tools/bundle.sh
echo "$key" > "$HERE/build/bundle.key"
