#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 Yousaf Khan
#
# Runs inside image/Dockerfile (build.sh starts it): copies Debian's Chromium
# and Mesa, with every library they load (glibc and its loader too), into
# one folder that runs as it is at $B on the head unit, and packs it as
# build/chromium.tgz.
#
# Why a bundle: the unit has glibc 2.27, Mesa 19.0 (i965, GL only: no Vulkan,
# so no WebGPU) and no NSS / fontconfig; its loader is /lib/ld-linux-x86-64.so.2
# (knowledge/head-unit.md). So nothing here uses the unit's libraries:
# chromium and chromium-sink ask for $B/lib/ld-linux-x86-64.so.2 (PT_INTERP),
# and server.js starts Chromium with LD_LIBRARY_PATH=$B/lib and the Vulkan and
# fontconfig paths pointing into $B (env.js).
#
# No GPU driver: Vulkan is Chromium's own SwiftShader (the CPU) only. 0.1.1's
# Mesa 22.3 ANV hung in the unit's 4.14 i915 and blacked out the HMI
# (knowledge/browser.md); the check at the end refuses any GPU driver.
#
#   sh /m/tools/bundle.sh       (in the image, the tool's folder at /m)
set -eu
B=/var/opt/vizualyse-chromium/chromium
OUT=/m/build
STAGE=/tmp/stage
R=$STAGE$B
rm -rf "$STAGE"
mkdir -p "$R/lib" "$R/locales" "$R/fonts" "$R/etc/fonts" "$R/licenses"

C=/usr/lib/chromium
for f in chromium chrome_crashpad_handler chrome_100_percent.pak chrome_200_percent.pak resources.pak icudtl.dat \
         snapshot_blob.bin v8_context_snapshot.bin libEGL.so libGLESv2.so libvulkan.so.1 libvk_swiftshader.so vk_swiftshader_icd.json; do
    cp "$C/$f" "$R/$f"
done
cp "$C/locales/en-US.pak" "$R/locales/"

M=/usr/lib/x86_64-linux-gnu
# and what is only ever dlopen()ed, so ldd can't see it: NSS's soft token and
# roots (Chromium aborts without them), libpci (the GPU's PCI ids)
for l in libEGL.so.1 libGLESv2.so.2 libturbojpeg.so.0 \
         libsoftokn3.so libfreebl3.so libfreeblpriv3.so libnssckbi.so libnssdbm3.so libpci.so.3 \
         libdl.so.2 libpthread.so.0 librt.so.1; do cp -L "$M/$l" "$R/lib/"; done
# (libdl, libpthread, librt: glibc 2.41's stubs. The unit's libraries in GPU
# mode ask for them; without these the unit's 2.27 ones load and fail.)

# Every library the ELF files load, resolved in this image, under its soname.
# The loader comes along; nothing of the unit's /usr/lib is needed.
closure() {
    for e in "$@"; do ldd "$e" 2>/dev/null; done | awk '/=> \// {print $1" "$3} /^\s*\/lib.*ld-linux/ {print "ld-linux-x86-64.so.2 "$1}' | sort -u
}
ELFS="$R/chromium $R/chrome_crashpad_handler $R/libEGL.so $R/libGLESv2.so $R/libvulkan.so.1 $R/libvk_swiftshader.so $(ls $R/lib/*.so*)"
pass=0
while :; do
    added=0
    closure $ELFS > /tmp/needed
    while read -r name path; do
        [ -e "$R/lib/$name" ] && continue
        cp -L "$path" "$R/lib/$name"
        ELFS="$ELFS $R/lib/$name"
        added=$((added + 1))
    done < /tmp/needed
    pass=$((pass + 1))
    [ $added -eq 0 ] && break
    [ $pass -gt 5 ] && { echo "bundle: the library closure does not settle" >&2; exit 1; }
done
[ -e "$R/lib/ld-linux-x86-64.so.2" ] || cp -L /lib64/ld-linux-x86-64.so.2 "$R/lib/"

# chromium and its crash handler start on the bundle's own loader (the unit's
# is glibc 2.27 and lives in /lib, not /lib64)
for e in chromium chrome_crashpad_handler; do patchelf --set-interpreter "$B/lib/ld-linux-x86-64.so.2" "$R/$e"; done

# The frame and touch helper (sink/), on the same loader and libraries.
gcc -O2 -g0 -std=gnu11 -Wall -Wextra -Werror \
    -Wl,--dynamic-linker=$B/lib/ld-linux-x86-64.so.2 -Wl,-rpath,$B/lib -Wl,--build-id=sha1 \
    -o "$R/chromium-sink" /m/sink/sink.c /m/sink/touch.c /m/sink/frame_out.c /m/sink/yuv.c -lturbojpeg -lpthread
strip --strip-unneeded "$R/chromium-sink"
gcc -O2 -std=gnu11 -Wall -Wextra -Werror -o /tmp/yuv_test /m/sink/yuv_test.c /m/sink/yuv.c && /tmp/yuv_test

# The GPU mode's libEGL.so.1 (gpu/egl_shim.c): the unit's own Mesa 19 EGL on
# the render node. Not a driver: it only loads the unit's. Its test runs in
# the unit's root filesystem (test/unit_test.js), from build/, not shipped.
mkdir -p "$R/gpu"
gcc -O2 -g0 -std=gnu11 -Wall -Wextra -Werror -shared -fPIC -fvisibility=hidden \
    -Wl,-soname,libEGL.so.1 -Wl,--build-id=sha1 -o "$R/gpu/libEGL.so.1" /m/gpu/egl_shim.c -ldl -lpthread
strip --strip-unneeded "$R/gpu/libEGL.so.1"
[ "$(nm -D --defined-only "$R/gpu/libEGL.so.1" | awk '$2 == "T" {print $3}' | sort | tr '\n' ' ')" = "eglGetDisplay eglGetProcAddress " ] \
    || { echo "bundle: the EGL shim exports more than eglGetDisplay and eglGetProcAddress" >&2; exit 1; }
mkdir -p "$OUT"
gcc -O2 -std=gnu11 -Wall -Wextra -Werror -Wl,--dynamic-linker=$B/lib/ld-linux-x86-64.so.2 \
    -o "$OUT/egl_shim_test" /m/gpu/egl_shim_test.c -ldl

# Fonts: DejaVu and Liberation (Arial / Times / Courier metrics), cached in the profile.
cp /usr/share/fonts/truetype/dejavu/*.ttf /usr/share/fonts/truetype/liberation/*.ttf "$R/fonts/"
cat > "$R/etc/fonts/fonts.conf" <<EOF
<?xml version="1.0"?>
<!DOCTYPE fontconfig SYSTEM "urn:fontconfig:fonts.dtd">
<fontconfig>
  <dir>$B/fonts</dir>
  <cachedir>/var/opt/vizualyse-chromium/profile/fontconfig</cachedir>
  <alias><family>sans-serif</family><prefer><family>DejaVu Sans</family></prefer></alias>
  <alias><family>serif</family><prefer><family>DejaVu Serif</family></prefer></alias>
  <alias><family>monospace</family><prefer><family>DejaVu Sans Mono</family></prefer></alias>
</fontconfig>
EOF

# Licences: the copyright file of every Debian package a bundled file came from.
find "$R" -type f | sed "s|^$R/||" > /tmp/files
for f in $(cat /tmp/files); do
    case $f in lib/*) n=$(basename "$f") ;; *) continue ;; esac
    dpkg -S "*/$n" 2>/dev/null | head -1 | cut -d: -f1
done | sort -u > /tmp/pkgs
echo chromium >> /tmp/pkgs; echo fonts-dejavu-core >> /tmp/pkgs; echo fonts-liberation >> /tmp/pkgs
for p in $(sort -u /tmp/pkgs); do
    [ -f "/usr/share/doc/$p/copyright" ] && cp "/usr/share/doc/$p/copyright" "$R/licenses/$p.txt"
done
{
    echo "vizualyse-chromium bundle"
    echo "chromium $(dpkg-query -W -f '${Version}' chromium)"
    echo "vulkan: swiftshader only (no GPU driver)"
    echo "glibc $(dpkg-query -W -f '${Version}' libc6)"
    echo "packages: $(sort -u /tmp/pkgs | tr '\n' ' ')"
} > "$R/VERSION"

# Nothing may come from outside the bundle: every NEEDED resolves in $R/lib
# (or next to chromium), with the bundle's loader, in an empty library path.
missing=0
for e in $ELFS "$R/chromium-sink" "$R/gpu/libEGL.so.1"; do
    for n in $(objdump -p "$e" | awk '/NEEDED/ {print $2}'); do
        [ -e "$R/lib/$n" ] || [ -e "$R/$n" ] || { echo "bundle: $(basename "$e") needs $n, not in the bundle" >&2; missing=1; }
    done
done
[ $missing -eq 0 ] || exit 1
# No GPU driver may come along (0.1.1's ANV blacked out the HMI): no Mesa
# Vulkan, DRI, GBM-backend or VA driver, no Vulkan ICD but SwiftShader's
# (libgbm.so.1, which chromium links, is only the loader: no backend).
bad=$(cd "$R" && find . \( -name 'libvulkan_*' -o -name '*_dri.so' -o -name '*_drv_video.so' \
      -o -name '*_gbm.so' -o -name 'libEGL_mesa*' -o -name '*icd*.json' \) ! -name vk_swiftshader_icd.json)
[ -z "$bad" ] || { echo "bundle: a GPU driver got in: $bad" >&2; exit 1; }

mkdir -p "$OUT"
cd "$STAGE"
tar --sort=name --mtime=@0 --owner=0 --group=0 --numeric-owner --format=gnu -cf - "${B#/}" | gzip -n -6 > "$OUT/chromium.tgz.tmp"
mv "$OUT/chromium.tgz.tmp" "$OUT/chromium.tgz"
cp "$R/VERSION" "$OUT/bundle-VERSION.txt"
echo "bundle: $(find "$R" -type f | wc -l) files, $(du -sh "$R" | cut -f1) unpacked, $(du -h "$OUT/chromium.tgz" | cut -f1) packed"
cat "$R/VERSION"
