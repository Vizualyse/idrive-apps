#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 Yousaf Khan
#
# Runs the head unit's own compositor, Winston, off the car: in the unit's
# root filesystem (container idrive-rootfs:I_21w12.2-1-4) with its own
# configuration, plugins and scene provider, the command line of its
# winston.service, but the centre display (HDMI-A-1) a null output, so it
# composes offscreen. Then runs CMD in the same container, against it
# (XDG_RUNTIME_DIR=/run/wayland, wayland-0, as on the car).
#
#   sh tools/winston-bench/run.sh stub|swrast [CMD [ARG...]]
#
#   stub    the unit's own i965 on the GPU bench's fake HD Graphics 505: the
#           real driver imports our dmabufs; no pixels (screenshots are black)
#   swrast  llvmpipe through the unit's libEGL / libgbm: real pixels
#           (screenshots show what Winston composed); no dmabuf import
#
# The bench is at /bench (build/), /out is OUT (default build/out, writable):
# Winston's log is /out/winston.log. KMS_SHIM_DEBUG=1 logs the fake card;
# WINSTON_ARGS adds to Winston's command line ("--param stdlog-level=3":
# its debug lines). `wo_bench grab` writes the composed centre screen to
# /out/grab.ppm (kms_shim's read-back) and /out/grab.png (Winston's own).
set -eu
export MSYS_NO_PATHCONV=1
HERE=$(cd "$(dirname "$0")" && pwd)
WIN_HERE=$(cd "$HERE" && (pwd -W 2>/dev/null || pwd))
IMG=idrive-rootfs:I_21w12.2-1-4
ROOTFS=${ROOTFS:-$HERE/../../../idrive-rootfs/20.40.2/rootfs.tar}
PRE="-e KMS_SHIM_GRAB=/out/grab -e LD_PRELOAD=/bench/kms_shim.so:/bench/stub/libintel_noop_drm_shim.so -e INTEL_STUB_GPU_PLATFORM=bxt"
case "${1:-}" in
    stub) ENV=$PRE ;;
    swrast) ENV="$PRE -e KMS_SHIM_SWRAST=1 -e GBM_ALWAYS_SOFTWARE=1 -e LIBGL_DRIVERS_PATH=/bench/swrast -e LD_LIBRARY_PATH=/bench/swrast" ;;
    *) echo "usage: run.sh stub|swrast [CMD [ARG...]]" >&2; exit 2 ;;
esac
shift
[ $# -gt 0 ] || set -- sh -c 'sleep 2; /bench/wo_bench order'
for v in KMS_SHIM_DEBUG EGL_LOG_LEVEL MESA_DEBUG WINSTON_ARGS; do
    if eval "[ -n \"\${$v:-}\" ]"; then ENV="$ENV -e $v"; fi
done
docker image inspect $IMG >/dev/null 2>&1 || docker import "$ROOTFS" $IMG >/dev/null
sh "$HERE/build.sh" >&2
OUT=${OUT:-$HERE/build/out}
mkdir -p "$OUT"
WIN_OUT=$(cd "$OUT" && (pwd -W 2>/dev/null || pwd))
# winston.service's ExecStart with its Environment, HDMI-A-1 as a null output
START='mkdir -p /run/wayland /tmp && chgrp 911 /run/wayland && chmod 0770 /run/wayland
export XDG_RUNTIME_DIR=/run/wayland XDG_CACHE_HOME=/run/wayland
umask 0002
/usr/bin/winston --param "null-output[HDMI-A-1]=0,0,1920,720,60" --param "output-model[HDMI-A-1]=center" \
  --param "output[HDMI-A-2]=disabled" ${WINSTON_ARGS:-} \
  --param "null-output[Virtual-2]=0,1080,360,208,60" --param "output-model[Virtual-2]=ic1" \
  --param "null-output[Virtual-3]=500,1080,360,208,60" --param "output-model[Virtual-3]=ic2" \
  --param "null-output[Virtual-4]=0,2000,360,208,60" --param "output-model[Virtual-4]=hud1" \
  --param "null-output[Virtual-5]=500,2000,360,208,60" --param "output-model[Virtual-5]=hud2" \
  > /out/winston.log 2>&1 &
i=0; while [ ! -S /run/wayland/wayland-0 ] && [ $i -lt 50 ]; do sleep 0.1; i=$((i+1)); done
grep -q "render order with" /out/winston.log || sleep 0.5
"$@"'
# shellcheck disable=SC2086 # ENV and DOCKER_ARGS are word lists
exec docker run --rm --platform linux/amd64 --network none -v "$WIN_HERE/build:/bench:ro" -v "$WIN_OUT:/out" \
    ${DOCKER_ARGS:-} $ENV $IMG sh -c "$START" sh "$@"
