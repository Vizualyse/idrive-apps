#!/bin/sh
# The unit's own decoder libraries, for the off-car tests, from a copy of
# its root filesystem (BMW's; not in git, .gitignore): the software Media
# SDK (the GPU's library has no GPU here; its hardware one is kept for
# checking imports), libva, libdrm. Each is put under its SONAME, the name
# moonlight-core dlopens; the tests point MOONLIGHT_MSDK_DIR and
# LD_LIBRARY_PATH here.
#   sh test/firmware/extract.sh [rootfs.tar]   (default ../../../idrive-rootfs/20.40.2/rootfs.tar)
set -eu
HERE=$(cd "$(dirname "$0")" && pwd)
TAR=${1:-$HERE/../../../../../idrive-rootfs/20.40.2/rootfs.tar}
[ -f "$TAR" ] || { echo "no root filesystem at $TAR" >&2; exit 1; }
OUT=$HERE/lib
TMP=$HERE/.x
rm -rf "$TMP" && mkdir -p "$OUT" "$TMP"
tar -xf "$TAR" -C "$TMP" usr/lib/libmfxsw64-p.so.1.24 usr/lib/libmfxhw64-p.so.1.24 usr/lib/libva.so.1.9900.0 \
    usr/lib/libva-drm.so.1.9900.0 usr/lib/libdrm.so.2.4.0 2>/dev/null
L=$TMP/usr/lib
cp "$L/libmfxsw64-p.so.1.24" "$OUT/libmfxsw64.so"
cp "$L/libmfxhw64-p.so.1.24" "$OUT/libmfxhw64.so"
cp "$L/libva.so.1.9900.0" "$OUT/libva.so.1"
cp "$L/libva-drm.so.1.9900.0" "$OUT/libva-drm.so.1"
cp "$L/libdrm.so.2.4.0" "$OUT/libdrm.so.2"
rm -rf "$TMP"
ls -l "$OUT"
