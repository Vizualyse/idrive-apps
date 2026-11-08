#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 Yousaf Khan
#
# Builds build/mosquitto (the broker only) for the unit: Mosquitto's source,
# pinned by version and SHA-256 (downloaded once into $MGU_DL_CACHE, default
# ~/.cache/mgu-dl, outside the tree: release builds run on a fresh export of
# it; CI keeps that folder in the Actions cache, .github/actions/mgu-dl, as
# mosquitto.org's TLS drops now and then), compiled in
# image/Dockerfile (Ubuntu 18.04, glibc 2.27 as the unit) without TLS,
# WebSockets, bridges, persistence or plugins' JSON, asking for the unit's
# loader (/lib/ld-linux-x86-64.so.2: the unit has no /lib64). Refuses a
# result that needs a glibc newer than 2.27 or a library the unit may lack.
# Also copies Mosquitto's licences into build/. Run by the packer
# (component.json "build"), or by hand:  sh native/vizualyse-bus/build.sh
# "sh build.sh fetch" only downloads the source into the cache.
set -eu
export MSYS_NO_PATHCONV=1   # Git Bash: leave container paths alone
HERE=$(cd "$(dirname "$0")" && pwd)
WIN_HERE=$(cd "$HERE" && (pwd -W 2>/dev/null || pwd))
VER=2.0.21
# mosquitto.org/files/source/mosquitto-2.0.21.tar.gz as downloaded 2026-11-08
SHA256=7ad5e84caeb8d2bb6ed0c04614b2a7042def961af82d87f688ba33db857b899d
CACHE=${MGU_DL_CACHE:-$HOME/.cache/mgu-dl}
TGZ=$CACHE/mosquitto-$VER.tar.gz
mkdir -p "$CACHE" "$HERE/build/dl"
if [ ! -f "$TGZ" ] || [ "$(sha256sum "$TGZ" | cut -c1-64)" != $SHA256 ]; then
    # a relative name: Windows' curl can't write to a Git Bash path
    (cd "$CACHE" && curl -fsSL --retry 5 --retry-delay 5 --retry-all-errors \
        -o mosquitto-$VER.tar.gz.part https://mosquitto.org/files/source/mosquitto-$VER.tar.gz)
    got=$(sha256sum "$TGZ.part" | cut -c1-64)
    [ "$got" = $SHA256 ] || { rm -f "$TGZ.part"; echo "build.sh: mosquitto-$VER.tar.gz is $got, not $SHA256" >&2; exit 1; }
    mv "$TGZ.part" "$TGZ"
fi
[ "${1:-}" = fetch ] && exit 0
cp "$TGZ" "$HERE/build/dl/"
IMG=idrive-bus-build:18.04-$(sha256sum "$HERE/image/Dockerfile" | cut -c1-8)
docker image inspect $IMG >/dev/null 2>&1 || docker build --platform linux/amd64 -q -t $IMG "$WIN_HERE/image" >/dev/null
docker run --rm --platform linux/amd64 -v "$WIN_HERE/build:/out" -v "$WIN_HERE/patches:/p:ro" $IMG sh -euc '
    tar -xzf /out/dl/mosquitto-'$VER'.tar.gz -C /b
    cd /b/mosquitto-'$VER'
    # 2.0.21 does not build without TLS as it comes (patches/no-tls-check.awk)
    awk -f /p/no-tls-check.awk src/conf.c > src/conf.c.new && mv src/conf.c.new src/conf.c
    # the broker only (src/), as small as it goes: a Unix socket is all it listens on
    make -s -C src mosquitto \
        WITH_TLS=no WITH_TLS_PSK=no WITH_WEBSOCKETS=no WITH_SRV=no WITH_UUID=no WITH_SYSTEMD=no \
        WITH_BRIDGE=no WITH_PERSISTENCE=no WITH_CJSON=no WITH_DOCS=no WITH_STATIC_WEBSOCKETS=no \
        WITH_UNIX_SOCKETS=yes WITH_EPOLL=yes WITH_ADNS=no WITH_SOCKS=no WITH_CONTROL=no \
        CFLAGS="-O2 -g0 -fno-ident" LDFLAGS="-Wl,--dynamic-linker=/lib/ld-linux-x86-64.so.2 -Wl,--build-id=none"
    strip --strip-all -o /out/mosquitto src/mosquitto
    for f in LICENSE.txt epl-v20 edl-v10; do cp $f /out/mosquitto-$f; done
    v=$(objdump -T /out/mosquitto | grep -o "GLIBC_[0-9.]*" | sort -t. -k1,1 -k2,2n -k3,3n -u | tail -1)
    case $v in GLIBC_2.[0-9]|GLIBC_2.1[0-9]|GLIBC_2.2[0-7]|GLIBC_2.[0-9].*|GLIBC_2.1[0-9].*|GLIBC_2.2[0-7].*) ;;
    *) echo "mosquitto needs $v, newer than the unit'"'"'s glibc 2.27" >&2; exit 1 ;; esac
    needed=$(objdump -p /out/mosquitto | awk "/NEEDED/ {print \$2}" | sort | tr "\n" " ")
    for n in $needed; do case $n in libc.so.6|libpthread.so.0|librt.so.1|libdl.so.2|libm.so.6) ;;
        *) echo "mosquitto needs $n, which the unit may not have" >&2; exit 1 ;; esac; done
    interp=$(readelf -l /out/mosquitto | sed -n "s/.*interpreter: \([^]]*\)].*/\1/p")
    [ "$interp" = /lib/ld-linux-x86-64.so.2 ] || { echo "mosquitto asks for the loader $interp, not the unit'"'"'s" >&2; exit 1; }
    echo "mosquitto '$VER': glibc up to $v; needs $needed; loader $interp"'
