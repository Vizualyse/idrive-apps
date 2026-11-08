#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 Yousaf Khan
#
# Runs Windows programs through Proton (PROTON_USE_WINED3D=1, its Wayland
# driver) off the car, on the head unit's own Mesa 19 with a stand-in GPU
# from tools/gpu-bench (stub: the unit's i965 on a fake HD 505, no pixels;
# swrast: Mesa 19 llvmpipe, real pixels).
#   sh test/run_bench.sh [none|stub|swrast] [PROGRAM ...]
# PROGRAM is a name from build/win (t_gdi64, t_d3d932, ...) or a path under
# build/; by default all of build/win. COMPOSITOR=weston|wl-sink (weston).
# Proton is in the Docker volume steam-bench-proton (tools/fetch_proton.sh;
# PROTON_VER picks the build), mounted at /proton. The Wine prefix is kept in
# the volume steam-bench-pfx-<PROTON_VER>-<WOW64> (making one takes a
# minute); `docker volume rm` it for a fresh one.
# Builds what's missing: the images, the test programs, the unit's GL
# (tools/unit_gl.sh), Proton, the GPU bench.
set -eu
export MSYS_NO_PATHCONV=1
HERE=$(cd "$(dirname "$0")/.." && pwd)
WIN_HERE=$(cd "$HERE" && (pwd -W 2>/dev/null || pwd))
GPU_BENCH=$HERE/../../tools/gpu-bench
GPU=${1:-swrast}; [ $# -gt 0 ] && shift

docker image inspect idrive-steam-bench:trixie >/dev/null 2>&1 \
    || docker build -q -f "$HERE/image/bench.Dockerfile" -t idrive-steam-bench:trixie "$HERE/image" >/dev/null
sh "$HERE/test/build_win.sh" >&2
[ -f "$HERE/build/unit-gl/dri/i965_dri.so" ] || sh "$HERE/tools/unit_gl.sh" >&2
export PROTON_VER=${PROTON_VER:-GE-Proton11-11}
sh "$HERE/tools/fetch_proton.sh" >/dev/null
[ "$GPU" = none ] || sh "$GPU_BENCH/build.sh" >&2
[ "${COMPOSITOR:-weston}" = wl-sink ] && sh "$HERE/test/build_wl_sink.sh" >&2
WIN_GPU_BENCH=$(cd "$GPU_BENCH/build" 2>/dev/null && (pwd -W 2>/dev/null || pwd) || echo /nonexistent)
# WOW64=new (the default) runs 32-bit programs in Wine's new WoW64, from its
# 64-bit side (PROTON_USE_WOW64=1, i.e. WINEARCH=wow64): the car has no 32-bit
# glibc or Mesa. Proton's 32-bit Unix side (lib/wine/i386-unix) is replaced
# by the volume's <PROTON_VER>-i386-unix-64only (fetch_proton.sh): only the
# 64-bit files Proton keeps there too (GE-Proton11: wine64, wine64-preloader,
# as in x86_64-unix; Wine's own 64-bit processes start through them), to show
# none of its 32-bit ELF files is needed. WOW64=classic is GE-Proton's default.
WOW64_ARGS=
if [ "${WOW64:-new}" = new ]; then
    WOW64_ARGS="-e PROTON_USE_WOW64=1 --mount type=volume,src=steam-bench-proton,dst=/proton/$PROTON_VER/files/lib/wine/i386-unix,volume-subpath=$PROTON_VER-i386-unix-64only,readonly"
fi

progs=
if [ $# -eq 0 ]; then
    for f in "$HERE"/build/win/*.exe; do progs="$progs /b/win/$(basename "$f")"; done
else
    for p in "$@"; do
        case "$p" in */*) progs="$progs /b/${p#build/}" ;; *) progs="$progs /b/win/${p%.exe}.exe" ;; esac
    done
fi
# Named, and removed on any exit: killing the docker client (a timeout) leaves
# the container running, with Wine holding the programs open.
NAME=steam-bench-$$
trap 'docker rm -f $NAME >/dev/null 2>&1' EXIT INT TERM
# shellcheck disable=SC2086 # progs and DOCKER_ARGS are word lists
docker run --rm --name $NAME --network none --shm-size=512m -v "$WIN_HERE/build:/b" -v "$WIN_HERE/test:/s:ro" \
    -v "$WIN_GPU_BENCH:/g:ro" -e GPU="$GPU" -e BENCH=/g -e UNIT_GL=/b/unit-gl \
    -e COMPOSITOR="${COMPOSITOR:-weston}" ${WINEDEBUG:+-e WINEDEBUG="$WINEDEBUG"} ${WINE_D3D_CONFIG:+-e WINE_D3D_CONFIG="$WINE_D3D_CONFIG"} \
    ${SHOW_COMPOSITOR:+-e SHOW_COMPOSITOR=1} ${WL_SINK_ARGS:+-e WL_SINK_ARGS="$WL_SINK_ARGS"} ${WL_SINK_WRAP:+-e WL_SINK_WRAP="$WL_SINK_WRAP"} \
    ${SHOW_LOG:+-e SHOW_LOG="$SHOW_LOG"} ${T_TIMEOUT:+-e T_TIMEOUT="$T_TIMEOUT"} \
    -v steam-bench-proton:/proton:ro $WOW64_ARGS \
    -v "steam-bench-pfx-$PROTON_VER-${WOW64:-new}:/pfx" -e PROTON="/proton/$PROTON_VER" \
    ${T_ENV:-} ${DOCKER_ARGS:-} idrive-steam-bench:trixie sh /s/in_bench.sh $progs
