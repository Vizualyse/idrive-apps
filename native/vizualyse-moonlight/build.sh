#!/bin/sh
# Builds build/moonlight-core for the unit (not PIE: Ubuntu's static libopus
# is not position-independent), in the image from image/Dockerfile
# (Ubuntu 18.04: glibc 2.27 and OpenSSL 1.1, as the unit), from core/*.c and
# the vendored moonlight-common-c (third_party/, VERSIONS names the commits),
# with fixed paths so two builds give the same bytes. Refuses a result that
# needs a glibc newer than the unit's 2.27 or a library the unit lacks (the
# GPU decoder's MSDK and libva are loaded with dlopen, not linked; FFmpeg's
# H.264 decoder is built in, from the image's static libavcodec).
# Runs core/pads_test.c and core/touch_test.c first; also builds
# build/decode_test (test/run_decode_test.sh). Draws the stop hint into
# build/hint.rgba (tools/make_hint.py).
# Run by the packer (component.json "build"), or by hand:
#   sh native/vizualyse-moonlight/build.sh
set -eu
export MSYS_NO_PATHCONV=1   # Git Bash: leave container paths alone
HERE=$(cd "$(dirname "$0")" && pwd)
WIN_HERE=$(cd "$HERE" && (pwd -W 2>/dev/null || pwd))
node "$WIN_HERE/../../platform/platform.js" sync "$WIN_HERE" >&2   # the pinned platform version's copies (component.json "platform")
IMG=idrive-moonlight-build:18.04-gcc8-ff612
docker image inspect $IMG >/dev/null 2>&1 || docker build --platform linux/amd64 -q -t $IMG "$WIN_HERE/image" >/dev/null
mkdir -p "$HERE/build"
docker run --rm --platform linux/amd64 -v "$WIN_HERE:/m" -w /m $IMG sh -c '
    set -e
    MCC=third_party/moonlight-common-c
    INC="-Icore -I/opt/ffmpeg/include -I$MCC/src -I$MCC/enet/include -I$MCC/nanors -I$MCC/nanors/deps -I$MCC/nanors/deps/obl"
    DEFS="-D_GNU_SOURCE= -DNDEBUG -DHAS_SOCKLEN_T -DHAS_FCNTL=1 -DHAS_IOCTL=1 -DHAS_POLL=1 -DHAS_GETADDRINFO=1 -DHAS_GETNAMEINFO=1 -DHAS_INET_PTON=1 -DHAS_INET_NTOP=1 -DHAS_MSGHDR_FLAGS=1 -DHAVE_CLOCK_GETTIME -DHAVE_CLOCK_MONOTONIC"
    CF="-O2 -g0 -std=gnu11 -fno-strict-aliasing -Wall"
    SRCS="$(ls $MCC/src/*.c) $MCC/enet/callbacks.c $MCC/enet/compress.c $MCC/enet/host.c $MCC/enet/list.c $MCC/enet/packet.c $MCC/enet/peer.c $MCC/enet/protocol.c $MCC/enet/unix.c $MCC/nanors/rs.c $MCC/nanors/deps/obl/oblas_common.c"
    FF="/opt/ffmpeg/lib/libavcodec.a /opt/ffmpeg/lib/libavutil.a"
    DEC="core/frame_out.c core/decode.c core/decode_av.c core/decode_msdk.c"
    gcc-8 $CF $INC $DEFS -Wextra -Wno-unused-parameter -Wno-maybe-uninitialized -Werror -o /tmp/pads_test core/pads_test.c core/pads.c
    /tmp/pads_test
    gcc-8 $CF $INC $DEFS -Wextra -Werror -o /tmp/touch_test core/touch_test.c core/touch.c
    /tmp/touch_test test/fixtures/id7-touch-capture.txt
    gcc-8 $CF -Icore -I/opt/ffmpeg/include -D_GNU_SOURCE= -Wextra -Wno-unused-parameter -Werror -no-pie -Wl,--dynamic-linker=/lib/ld-linux-x86-64.so.2 -o build/decode_test core/decode_test.c $DEC $FF -lpthread -lm -ldl
    # nanors'"'"' SIMD file needs intrinsics newer than gcc 8 (core/compat_gcc8.h)
    gcc-8 $CF $INC $DEFS -include core/compat_gcc8.h -c -o /tmp/oblas_lite.o $MCC/nanors/deps/obl/oblas_lite.c
    gcc-8 $CF $INC $DEFS -no-pie -Wl,--dynamic-linker=/lib/ld-linux-x86-64.so.2 -Wl,--build-id=sha1 -Wl,-z,relro,-z,now -Wl,--as-needed -o build/moonlight-core \
        core/moonlight_core.c core/pads.c core/touch.c $DEC $SRCS /tmp/oblas_lite.o $FF -Wl,-Bstatic -lopus -Wl,-Bdynamic -lcrypto -lpthread -lm -ldl
    strip --strip-unneeded build/moonlight-core
    v=$(objdump -T build/moonlight-core | grep -o "GLIBC_[0-9.]*" | sort -t. -k1,1 -k2,2n -k3,3n -u | tail -1)
    case $v in GLIBC_2.[0-9]|GLIBC_2.1[0-9]|GLIBC_2.2[0-7]|GLIBC_2.[0-9].*|GLIBC_2.1[0-9].*|GLIBC_2.2[0-7].*) ;;
    *) echo "moonlight-core needs $v, newer than the unit'"'"'s glibc 2.27" >&2; exit 1 ;; esac
    # the unit has its loader in /lib, no /lib64 (seen on the car)
    interp=$(readelf -l build/moonlight-core | sed -n "s/.*program interpreter: \(.*\)\]/\1/p")
    [ "$interp" = /lib/ld-linux-x86-64.so.2 ] || { echo "moonlight-core asks for the loader \"$interp\", not the unit'"'"'s /lib/ld-linux-x86-64.so.2" >&2; exit 1; }
    needed=$(objdump -p build/moonlight-core | awk "/NEEDED/ {print \$2}" | sort | tr "\n" " ")
    for l in $needed; do case $l in libc.so.6|libm.so.6|libpthread.so.0|libdl.so.2|libcrypto.so.1.1) ;; *) echo "moonlight-core needs $l" >&2; exit 1 ;; esac; done
    echo "moonlight-core: glibc up to $v; loader $interp; needs $needed"
    cp /opt/ffmpeg/COPYING.LGPLv2.1 build/ffmpeg-LGPL-2.1.txt
    python3 tools/make_hint.py /usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf build/hint.rgba'
