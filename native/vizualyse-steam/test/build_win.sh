#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 Yousaf Khan
#
# Builds the Windows test programs (test/win/*.c) as build/win/NAME64.exe and
# NAME32.exe with mingw-w64 (image/mingw.Dockerfile). Rebuilds a program
# when its source or test/win/tlog.h is newer.
set -eu
export MSYS_NO_PATHCONV=1
HERE=$(cd "$(dirname "$0")/.." && pwd)
docker image inspect idrive-steam-mingw:trixie >/dev/null 2>&1 \
    || docker build -q -f "$HERE/image/mingw.Dockerfile" -t idrive-steam-mingw:trixie "$HERE/image" >/dev/null
# build/win is made here and mounted on its own: through a mount of build/,
# Docker Desktop kept seeing a build/win that had been removed.
mkdir -p "$HERE/build/win"
SRC=$(cd "$HERE/test/win" && (pwd -W 2>/dev/null || pwd))
OUT=$(cd "$HERE/build/win" && (pwd -W 2>/dev/null || pwd))
docker run --rm -v "$SRC:/src:ro" -v "$OUT:/out" idrive-steam-mingw:trixie sh -euc '
    for c in /src/*.c; do
        t=$(basename "$c" .c)
        # tr: a Windows checkout (core.autocrlf) ends the line in a CR
        libs=$(sed -n "s#^ \* libs: ##p" "$c" | tr -d "\r")
        for arch in x86_64:64 i686:32; do
            out=/out/$t${arch#*:}.exe
            [ "$out" -nt "$c" ] && [ "$out" -nt /src/tlog.h ] && continue
            # -mwindows: a GUI program, as games are (a console one gets a
            # Wine console window of its own); the lines go to T_LOG.
            ${arch%:*}-w64-mingw32-gcc -O2 -Wall -Werror -mwindows -o "$out" "$c" $libs
        done
    done'
