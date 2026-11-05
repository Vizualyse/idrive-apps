#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 Yousaf Khan
#
# Builds build/chromium.tgz: Debian trixie's Chromium and Mesa with every
# library they load, chromium-sink (sink/) beside them, all on their own
# loader, to unpack at /var/opt/vizualyse-chromium/chromium on the unit
# (tools/bundle.sh says why and what). In the image from image/Dockerfile;
# fixed paths, sorted and dated tar: two builds give the same bytes.
# Runs sink/yuv_test.c first. Kept when its inputs haven't changed.
# Run by the packer (component.json "build"), or by hand:
#   sh native/vizualyse-chromium/build.sh
set -eu
export MSYS_NO_PATHCONV=1   # Git Bash: leave container paths alone
HERE=$(cd "$(dirname "$0")" && pwd)
WIN_HERE=$(cd "$HERE" && (pwd -W 2>/dev/null || pwd))
IMG=idrive-chromium-build:trixie-156.0.8078.79-$(sha256sum "$HERE/image/Dockerfile" | cut -c1-8)
docker image inspect $IMG >/dev/null 2>&1 || docker build --platform linux/amd64 -q -t $IMG "$WIN_HERE/image" >/dev/null
mkdir -p "$HERE/build"
key=$( (cat "$HERE/image/Dockerfile" "$HERE/tools/bundle.sh" "$HERE"/sink/*; docker image inspect -f '{{.Id}}' $IMG) | sha256sum | cut -c1-16)
if [ -f "$HERE/build/chromium.tgz" ] && [ "$(cat "$HERE/build/chromium.key" 2>/dev/null)" = "$key" ]; then
    echo "chromium.tgz: up to date ($key)"
    exit 0
fi
docker run --rm --platform linux/amd64 -v "$WIN_HERE:/m" $IMG sh /m/tools/bundle.sh
echo "$key" > "$HERE/build/chromium.key"
