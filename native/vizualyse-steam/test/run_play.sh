#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 Yousaf Khan
#
# The tool left running off the car, to play a real game on it: a container
# made from the head unit's own root filesystem (as test/run_unit_test.sh),
# with the internet (DepotDownloader), the phone page on this PC's
# http://localhost:8494, /var/opt in the Docker volume steam-play-varopt (the
# bundles unpacked, the sign-in, the games, the prefix: kept between runs; the
# games off the Windows drive) and the GPU bench's stand-in GPU
# (test/play_main.js says what that can and can't tell).
#   sh native/vizualyse-steam/test/run_play.sh [start]     starts it (again), prints the page's link
#   sh native/vizualyse-steam/test/run_play.sh log [N]     the tool's log (its last N lines)
#   sh native/vizualyse-steam/test/run_play.sh perf        the "perf:" lines kept in state/perf.log
#   sh native/vizualyse-steam/test/run_play.sh api PATH [JSON]   the page's API (GET, or POST with a body)
#   sh native/vizualyse-steam/test/run_play.sh shot FILE.png   the game's newest picture (pixels: GPU=lavapipe or swrast)
#   sh native/vizualyse-steam/test/run_play.sh tap X Y | drag X1 Y1 X2 Y2 | pad BUTTONS | stick LX LY [MS]
#                                                           a touch on the picture, a controller (test/play_input.js)
#   sh native/vizualyse-steam/test/run_play.sh sh [CMD...]  a shell in it
#   sh native/vizualyse-steam/test/run_play.sh stop
# GPU=stub|swrast|lavapipe (stub). lavapipe: a Vulkan game draws on Mesa's CPU
# Vulkan driver (the lavapipe of tools/vk-trial's test image, copied once into
# the volume as /var/opt/lvp) in place of ANV on the stub: real pictures, slowly,
# to see a game and steer it (test/play_input.js); OpenGL stays on the stub.
# PLAY_CRUMBS=off: no log of a Vulkan game's DRM calls; =all: every call written (as up to 0.2.3).
# PLAY_SYNC=fsync: Wine's fsync (the server's own by default, as on the car's kernel).
# PLAY_ENV='{"NAME":"value"}': more of the game's environment, over the tool's own.
# PLAY_UNCAPPED=1: a DXVK game with no frame limit and vsync off (what a change costs in frames).
# PLAY_FAKE=t_d3d964.exe: no Steam at all, a stand-in download (test/fake_dd.js: the
# password "hunter2", the code 12345) that installs that test program as the game,
# to check this bench itself; with PLAY_VOLUME=steam-play-selftest, a volume of its own.
# PLAY_CPUS=0-3 (docker --cpuset-cpus), PLAY_CPU_SHARE=1.5 (--cpus), PLAY_MEMORY=6g (--memory):
# narrower, though a PC core is not an Atom core.
set -eu
export MSYS_NO_PATHCONV=1
HERE=$(cd "$(dirname "$0")/.." && pwd)
WIN_HERE=$(cd "$HERE" && (pwd -W 2>/dev/null || pwd))
GPU_BENCH=$HERE/../../tools/gpu-bench
VKT=$HERE/../../tools/vk-trial
IMG=idrive-rootfs:I_21w12.2-1-4
NAME=steam-play
VOL=${PLAY_VOLUME:-steam-play-varopt}
PORT=${STEAM_PORT:-8494}
token() { docker exec $NAME cat /var/opt/vizualyse-steam/state/token 2>/dev/null | tr -d '\r\n'; }
case "${1:-start}" in
    start)
        ROOTFS=${ROOTFS:-$HERE/../../../idrive-rootfs/20.40.2/rootfs.tar}
        docker image inspect $IMG >/dev/null 2>&1 || docker import "$ROOTFS" $IMG >/dev/null
        sh "$HERE/build.sh" >&2
        sh "$GPU_BENCH/build.sh" >&2
        [ -f "$VKT/build/bench/kernel414.so" ] || MESA_VER=22.3.7 sh "$VKT/build.sh" >&2
        [ -z "${PLAY_FAKE:-}" ] || sh "$HERE/test/build_win.sh" >&2
        docker volume create "$VOL" >/dev/null
        if [ "${GPU:-stub}" = lavapipe ]; then
            # lavapipe as the tool's Vulkan driver (env.js STEAM_VK_TRIAL: vk-trial's layout): its
            # libvulkan_lvp.so under ANV's name, its loader, the libraries they need that the tool's
            # runtime lacks (the runtime's own stay: they are newer), the tool's vk_crumbs.so and DXVK.
            # Made once the bundles are unpacked (a first start on the stub does that).
            LIMG=idrive-vk-trial-lavapipe:$(sha256sum < "$VKT/test/lavapipe/Dockerfile" | cut -c1-8)
            docker image inspect "$LIMG" >/dev/null 2>&1 || docker build -q -t "$LIMG" "$(cd "$VKT/test/lavapipe" && (pwd -W 2>/dev/null || pwd))" >/dev/null
            docker run --rm --network none -v "$VOL:/var/opt" "$LIMG" sh -ec '
                D=/var/opt/lvp; R=/var/opt/vizualyse-steam/runtime/lib; L=/usr/lib/x86_64-linux-gnu
                [ -f $D/lib/libvulkan_intel.so ] && exit 0
                [ -d $R ] || { echo "run_play: no unpacked bundles in the volume yet: start once with GPU=stub" >&2; exit 1; }
                mkdir -p $D/lib $D/dxvk
                cp -L $L/libvulkan.so.1 $D/lib/libvulkan.so.1
                for f in $(ldd $L/libvulkan_lvp.so $L/libvulkan.so.1 | awk "/=> \//{print \$3}" | sort -u); do
                    b=$(basename $f)
                    case $b in libc.so*|libm.so*|libpthread.so*|libdl.so*|librt.so*|ld-linux*) continue ;; esac
                    [ -e $R/$b ] || cp -L $f $D/lib/$b
                done
                cp /var/opt/vizualyse-steam/vulkan/lib/vk_crumbs.so $D/lib/
                dpkg-query -W -f "\${Version}" mesa-vulkan-drivers | sed "s/-.*//" > $D/lib/mesa
                ln -sfn /var/opt/vizualyse-steam/vulkan/dxvk $D/dxvk/dxvk
                cp -L $L/libvulkan_lvp.so $D/lib/libvulkan_intel.so
                echo "run_play: lavapipe $(cat $D/lib/mesa) in the volume ($(ls $D/lib | wc -l) libraries)" >&2'
        fi
        docker rm -f $NAME >/dev/null 2>&1 || true
        # shellcheck disable=SC2086 # the PLAY_ options are word lists
        docker run -d --name $NAME --platform linux/amd64 --shm-size=4g --cap-add SYS_ADMIN -p "127.0.0.1:$PORT:8494" \
            ${PLAY_CPUS:+--cpuset-cpus "$PLAY_CPUS"} ${PLAY_CPU_SHARE:+--cpus "$PLAY_CPU_SHARE"} ${PLAY_MEMORY:+--memory "$PLAY_MEMORY"} \
            -v "$VOL:/var/opt" -v "$WIN_HERE:/t:ro" -v "$(cd "$GPU_BENCH/build" && (pwd -W 2>/dev/null || pwd)):/g:ro" \
            -v "$(cd "$VKT/build" && (pwd -W 2>/dev/null || pwd)):/vkt:ro" \
            -e GPU="${GPU:-stub}" ${PLAY_CRUMBS:+-e PLAY_CRUMBS="$PLAY_CRUMBS"} ${PLAY_FAKE:+-e PLAY_FAKE="$PLAY_FAKE"} ${PLAY_SYNC:+-e PLAY_SYNC="$PLAY_SYNC"} ${PLAY_ENV:+-e PLAY_ENV="$PLAY_ENV"} ${PLAY_UNCAPPED:+-e PLAY_UNCAPPED=1} ${STEAM_WINEDEBUG:+-e STEAM_WINEDEBUG="$STEAM_WINEDEBUG"} $IMG \
            /bin/sh -c "mkdir -p /tmp /run && chmod 1777 /tmp && ulimit -c 0 && ulimit -n 524288 2>/dev/null; exec /usr/bin/node /t/test/play_main.js /t" >/dev/null
        i=0
        while [ -z "$(token)" ] && [ $i -lt 60 ]; do sleep 1; i=$((i + 1)); done
        [ -n "$(token)" ] || { docker logs --tail 30 $NAME >&2; echo "run_play: the tool did not start" >&2; exit 1; }
        echo "the page: http://localhost:$PORT/?t=$(token)"
        echo "(the bundles unpack on a first start: about half a minute; sh test/run_play.sh log)"
        ;;
    log) docker logs --tail "${2:-60}" $NAME 2>&1 ;;
    perf) docker exec $NAME sh -c 'cat /var/opt/vizualyse-steam/state/perf.log.1 /var/opt/vizualyse-steam/state/perf.log 2>/dev/null' ;;
    api)
        if [ $# -ge 3 ]; then curl -s -H "X-Steam-Token: $(token)" -H 'Content-Type: application/json' -d "$3" "http://localhost:$PORT$2"
        else curl -s -H "X-Steam-Token: $(token)" "http://localhost:$PORT$2"; fi
        echo ;;
    shot) docker exec $NAME /usr/bin/node /t/test/play_input.js shot > "$2" ;;
    tap|drag|pad|stick) docker exec $NAME /usr/bin/node /t/test/play_input.js "$@" ;;
    sh) shift; if [ $# -gt 0 ]; then docker exec $NAME "$@"; else docker exec -it $NAME /bin/sh; fi ;;
    stop) docker stop -t 30 $NAME >/dev/null 2>&1 || true; docker rm -f $NAME >/dev/null 2>&1 || true ;;
    *) sed -n '5,22p' "$0" >&2; exit 2 ;;
esac
