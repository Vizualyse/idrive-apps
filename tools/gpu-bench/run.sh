#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 Yousaf Khan
#
# Runs a program in the head unit's root filesystem (container
# idrive-rootfs:I_21w12.2-1-4, from ../idrive-rootfs, no network) with a
# stand-in for its GPU, on the unit's own Mesa 19.0.6 libraries:
#
#   stub    the unit's own i965_dri.so on a fake Apollo Lake HD Graphics 505
#           (Mesa's no-op DRM shim, preloaded). Real driver, real shader
#           compiler, real GL limits and extensions; the GPU runs nothing, so
#           pixels read back are zeros and there is no timing.
#   swrast  Mesa 19.0.6's llvmpipe through the unit's libEGL / libgbm (on the
#           shim's fake DRM node). Real pixels, on the CPU; not i965's
#           extensions, limits or bugs.
#
#   sh tools/gpu-bench/run.sh stub|swrast                 the smoke test (build/gltest)
#   sh tools/gpu-bench/run.sh stub|swrast CMD [ARG...]    CMD in the container
#
# The bench is at /bench (build/); MOUNT=dir puts dir at /t (read-only).
# Programs run on the unit's libraries (glibc 2.27; link with
# -Wl,--dynamic-linker=/lib/ld-linux-x86-64.so.2). Mesa's debug variables
# pass through when set (INTEL_DEBUG, MESA_DEBUG, EGL_LOG_LEVEL, ...);
# DOCKER_ARGS adds docker run options (e.g. "--cpus=1 --memory=1536m").
set -eu
export MSYS_NO_PATHCONV=1
HERE=$(cd "$(dirname "$0")" && pwd)
WIN_HERE=$(cd "$HERE" && (pwd -W 2>/dev/null || pwd))
IMG=idrive-rootfs:I_21w12.2-1-4
ROOTFS=${ROOTFS:-$HERE/../../../idrive-rootfs/20.40.2/rootfs.tar}
SHIM="-e LD_PRELOAD=/bench/stub/libintel_noop_drm_shim.so -e INTEL_STUB_GPU_PLATFORM=bxt"
case "${1:-}" in
    stub) ENV=$SHIM; DEFAULT="/bench/gltest --desktop-gl" ;;
    swrast) ENV="$SHIM -e GBM_ALWAYS_SOFTWARE=1 -e LIBGL_DRIVERS_PATH=/bench/swrast -e LD_LIBRARY_PATH=/bench/swrast"
            DEFAULT="/bench/gltest --pixels --desktop-gl" ;;
    *) echo "usage: run.sh stub|swrast [CMD [ARG...]]" >&2; exit 2 ;;
esac
shift
[ $# -gt 0 ] || set -- $DEFAULT
for v in INTEL_DEBUG MESA_DEBUG LIBGL_DEBUG EGL_LOG_LEVEL GALLIUM_DRIVER LP_NUM_THREADS LP_DEBUG \
         MESA_GL_VERSION_OVERRIDE MESA_GLSL_VERSION_OVERRIDE MESA_EXTENSION_OVERRIDE; do
    if eval "[ -n \"\${$v:-}\" ]"; then ENV="$ENV -e $v"; fi
done
docker image inspect $IMG >/dev/null 2>&1 || docker import "$ROOTFS" $IMG >/dev/null
sh "$HERE/build.sh" >&2
MNT=
[ -n "${MOUNT:-}" ] && MNT=$(cd "$MOUNT" && (pwd -W 2>/dev/null || pwd))
# shellcheck disable=SC2086 # ENV and DOCKER_ARGS are word lists
exec docker run --rm --platform linux/amd64 --network none -v "$WIN_HERE/build:/bench:ro" \
    ${MNT:+-v "$MNT:/t:ro"} ${DOCKER_ARGS:-} $ENV $IMG "$@"
