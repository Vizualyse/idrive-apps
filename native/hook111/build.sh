#!/bin/sh
# Builds build/libhook111.so for the unit (carplay 20.40.2): in the image from
# image/Dockerfile (Ubuntu 18.04, glibc 2.27 as the unit), from src/*.c, with
# fixed paths so two builds give the same bytes. Refuses a result that needs
# a glibc newer than the unit's 2.27. Everything it reads is in this folder,
# so release.js sees every change to what ships. Run by the packer
# (component.json "build"), or by hand:  sh native/hook111/build.sh
set -eu
export MSYS_NO_PATHCONV=1   # Git Bash: leave container paths alone
HERE=$(cd "$(dirname "$0")" && pwd)
WIN_HERE=$(cd "$HERE" && (pwd -W 2>/dev/null || pwd))
IMG=idrive-re-harness:18.04
docker image inspect $IMG >/dev/null 2>&1 || docker build --platform linux/amd64 -q -t $IMG "$WIN_HERE/image" >/dev/null
mkdir -p "$HERE/build"
docker run --rm --platform linux/amd64 -v "$WIN_HERE:/src" -w /src $IMG sh -c '
    set -e
    gcc -O2 -g0 -Wall -Werror -shared -fPIC -fvisibility=hidden \
        -Wl,--build-id=sha1 -Wl,-z,relro,-z,now -o build/libhook111.so src/preload.c -ldl -lpthread
    strip --strip-unneeded build/libhook111.so
    v=$(objdump -T build/libhook111.so | grep -o "GLIBC_[0-9.]*" | sort -t. -k1,1 -k2,2n -k3,3n -u | tail -1)
    case $v in GLIBC_2.[0-9]|GLIBC_2.1[0-9]|GLIBC_2.2[0-7]|GLIBC_2.[0-9].*|GLIBC_2.1[0-9].*|GLIBC_2.2[0-7].*) ;;
    *) echo "libhook111.so needs $v, newer than the unit'"'"'s glibc 2.27" >&2; exit 1 ;; esac
    exports=$(objdump -T build/libhook111.so | awk "\$2 == \"g\" && \$4 == \".text\" {print \$NF}" | sort | tr "\n" " ")
    [ "$exports" = "dlopen hook111_preload_state " ] || { echo "unexpected exports: $exports" >&2; exit 1; }
    echo "libhook111.so: glibc up to $v; exports: $exports"'
