#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 Yousaf Khan
#
# The GPU bench's own test: both stand-ins in the unit's root filesystem.
#   stub    the unit's i965 must load as the car's chip (the GL_RENDERER and
#           GL_VERSION the car reports, knowledge/browser.md), compile, link
#           and draw with no GL error and no ioctl the shim doesn't answer;
#   swrast  llvmpipe through the unit's EGL must draw the right pixels.
#   sh tools/gpu-bench/test/run_test.sh
set -eu
HERE=$(cd "$(dirname "$0")/.." && pwd)
fails=0
expect() { # mode output pattern what
    if printf '%s\n' "$2" | grep -qF -- "$3"; then echo "  ok   $1: $4"
    else echo "  FAIL $1: $4 (no \"$3\")"; fails=$((fails + 1)); fi
}
refuse() { # mode output pattern what
    if printf '%s\n' "$2" | grep -qF -- "$3"; then echo "  FAIL $1: $4"; fails=$((fails + 1))
    else echo "  ok   $1: $4"; fi
}
out=$(sh "$HERE/run.sh" stub 2>&1) || true
expect stub "$out" "gl_renderer: Mesa DRI Intel(R) HD Graphics 505 (Broxton)" "the unit's i965 as the car's chip"
expect stub "$out" "gl_version: OpenGL ES 3.2 Mesa 19.0.6" "GLES 3.2 on Mesa 19.0.6"
expect stub "$out" "desktop_gl_core: 4.5 (Core Profile) Mesa 19.0.6" "desktop GL 4.5 core"
refuse stub "$out" "DRM_SHIM: unhandled" "every ioctl answered"
expect stub "$out" "result: ok" "context, shaders, draw, read back"
stub_out=$out
out=$(sh "$HERE/run.sh" swrast 2>&1) || true
expect swrast "$out" "gl_renderer: llvmpipe" "llvmpipe through the unit's EGL / GBM"
expect swrast "$out" "result: ok" "the pixels drawn"
[ $fails -eq 0 ] || { printf '== stub\n%s\n== swrast\n%s\n' "$stub_out" "$out" >&2; echo "gpu-bench: $fails failed" >&2; exit 1; }
echo "gpu-bench: all passed"
