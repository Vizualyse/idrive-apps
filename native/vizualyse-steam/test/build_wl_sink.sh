#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 Yousaf Khan
#
# Builds build/wl-sink (src/wl_sink.c) in the bench image and runs
# src/rgb_test.c first. For the bench only so far: the car's build will be
# against the tool's bundle (its own glibc), like the browser's.
set -eu
export MSYS_NO_PATHCONV=1
HERE=$(cd "$(dirname "$0")/.." && pwd)
WIN_HERE=$(cd "$HERE" && (pwd -W 2>/dev/null || pwd))
node "$WIN_HERE/../../platform/platform.js" sync "$WIN_HERE" >&2   # the pinned platform version's copies (component.json "platform")
mkdir -p "$HERE/build/wl-sink-gen"
SRC=$(cd "$HERE/src" && (pwd -W 2>/dev/null || pwd))
OUT=$(cd "$HERE/build" && (pwd -W 2>/dev/null || pwd))
docker image inspect idrive-steam-bench:trixie >/dev/null 2>&1 \
    || docker build -q -f "$HERE/image/bench.Dockerfile" -t idrive-steam-bench:trixie "$HERE/image" >/dev/null
docker run --rm -v "$SRC:/src:ro" -v "$OUT:/out" idrive-steam-bench:trixie sh -euc '
    G=/out/wl-sink-gen
    XDG=/usr/share/wayland-protocols/stable/xdg-shell/xdg-shell.xml
    wayland-scanner server-header $XDG $G/xdg-shell-server-protocol.h
    wayland-scanner private-code $XDG $G/xdg-shell-protocol.c
    wayland-scanner server-header /src/protocol/wayland-drm.xml $G/wayland-drm-server-protocol.h
    wayland-scanner private-code /src/protocol/wayland-drm.xml $G/wayland-drm-protocol.c
    VP=/usr/share/wayland-protocols/stable/viewporter/viewporter.xml
    wayland-scanner server-header $VP $G/viewporter-server-protocol.h
    wayland-scanner private-code $VP $G/viewporter-protocol.c
    gcc -O2 -Wall -Wextra -Werror -o /tmp/rgb_test /src/rgb_test.c /src/rgb.c && /tmp/rgb_test
    gcc -O2 -std=gnu11 -Wall -Wextra -Werror -I/src -I$G -o /out/wl-sink \
        /src/wl_sink.c /src/rgb.c /src/frame_out.c $G/xdg-shell-protocol.c $G/wayland-drm-protocol.c $G/viewporter-protocol.c \
        $(pkg-config --cflags --libs wayland-server) -ldl
    echo "wl-sink: built"'
