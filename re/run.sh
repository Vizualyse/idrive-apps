#!/bin/sh
# Off-car analysis, all in the idrive-re container. Nothing here reaches a car.
#
#   re/run.sh build                           build the image
#   re/run.sh extract <rootfs.tar> <name>     unpack into docker volume idrive-rootfs-<name>
#   re/run.sh survey <name> [<target> ...]    survey.py over that root file system;
#                                             a target is a path inside it (/usr/lib/x.so)
#                                             or a host file (resolved against it)
#   re/run.sh ghidra <name> <path-in-rootfs>  Ghidra headless + ExportAltScreen
#   re/run.sh selftest                        everything above on synthetic binaries
#
# Results go to re/out/<name>/ (git-ignored). The root file systems live in
# docker volumes, which keep their symlinks and modes; BMW and Cinemo bytes
# never enter the repository.
set -eu
export MSYS_NO_PATHCONV=1   # Git Bash: leave container paths alone

HERE=$(cd "$(dirname "$0")" && pwd)
IMAGE=idrive-re:ghidra-12.1.4
WIN_HERE=$(cd "$HERE" && (pwd -W 2>/dev/null || pwd))
RUN="docker run --rm --platform linux/amd64 -v $WIN_HERE:/re"

cmd=${1:-}; [ $# -gt 0 ] && shift
case "$cmd" in
build)
    docker build --platform linux/amd64 -t "$IMAGE" "$WIN_HERE/docker" ;;
extract)
    TAR=${1:?rootfs.tar}; NAME=${2:?name}
    TARDIR=$(cd "$(dirname "$TAR")" && (pwd -W 2>/dev/null || pwd))
    docker volume create "idrive-rootfs-$NAME" >/dev/null
    $RUN -v "$TARDIR:/in:ro" -v "idrive-rootfs-$NAME:/rootfs" "$IMAGE" \
        sh -c "tar -xf /in/$(basename "$TAR") -C /rootfs --no-same-owner 2>&1 | grep -v 'Cannot mknod' || true; du -sh /rootfs" ;;
survey)
    NAME=${1:?name}; shift
    ARGS=""; MOUNTS=""; n=0
    for t in "$@"; do
        case "$t" in
        /*) [ -f "$t" ] || { ARGS="$ARGS --target /rootfs$t"; continue; } ;;
        esac
        n=$((n + 1)); d=$(cd "$(dirname "$t")" && (pwd -W 2>/dev/null || pwd))
        MOUNTS="$MOUNTS -v $d:/t$n:ro"; ARGS="$ARGS --target /t$n/$(basename "$t")"
    done
    mkdir -p "$HERE/out/$NAME"
    $RUN $MOUNTS -v "idrive-rootfs-$NAME:/rootfs:ro" "$IMAGE" \
        python3 /re/survey.py --rootfs /rootfs --out "/re/out/$NAME" $ARGS ;;
ghidra)
    NAME=${1:?name}; P=${2:?path in rootfs}
    mkdir -p "$HERE/out/$NAME"
    $RUN -v "idrive-rootfs-$NAME:/rootfs:ro" "$IMAGE" sh -c "
        mkdir -p /tmp/proj && cp -L '/rootfs$P' /tmp/target &&
        /opt/ghidra/support/analyzeHeadless /tmp/proj p -import /tmp/target -scriptPath /re/ghidra \
            -postScript ExportAltScreen.java '/re/out/$NAME/$(basename "$P").tsv' \
            -postScript ExportLogNames.java '/re/out/$NAME/$(basename "$P").names.tsv' \
            -deleteProject 2>&1 | grep -E 'ExportLogNames:|ERROR|Exception' | tail -5" ;;
decompile)
    NAME=${1:?name}; P=${2:?path in rootfs}; OUTF=${3:?out name}; shift 3
    mkdir -p "$HERE/out/$NAME"
    $RUN -v "idrive-rootfs-$NAME:/rootfs:ro" "$IMAGE" sh -c "
        mkdir -p /tmp/proj && cp -L '/rootfs$P' /tmp/target &&
        /opt/ghidra/support/analyzeHeadless /tmp/proj p -import /tmp/target -scriptPath /re/ghidra \
            -postScript Decompile.java '/re/out/$NAME/$OUTF' $* -deleteProject 2>&1 | grep -E 'ERROR|Exception' | tail -5" ;;
decompile-all)
    NAME=${1:?name}; P=${2:?path in rootfs}
    mkdir -p "$HERE/out/$NAME"
    $RUN -v "idrive-rootfs-$NAME:/rootfs:ro" "$IMAGE" sh -c "
        mkdir -p /tmp/proj && cp -L '/rootfs$P' /tmp/target &&
        /opt/ghidra/support/analyzeHeadless /tmp/proj p -import /tmp/target -scriptPath /re/ghidra \
            -postScript DecompileAll.java '/re/out/$NAME/$(basename "$P").all.c' -deleteProject 2>&1 | grep -E 'DecompileAll:|ERROR|Exception' | tail -5" ;;
harness)
    # screen_b against the unit's own libraries (re/harness/screen_b.c):
    # built for glibc 2.27, run by the unit's own loader from the root file system
    NAME=${1:?name}; MODE=${2:-aes}; N=${3:-12}
    HIMG=idrive-re-harness:18.04
    docker image inspect $HIMG >/dev/null 2>&1 || docker build --platform linux/amd64 -q -t $HIMG "$WIN_HERE/harness" >/dev/null
    mkdir -p "$HERE/out/harness"
    $RUN $HIMG sh -c 'gcc -O1 -g -Wall -o /re/out/harness/screen_b /re/harness/screen_b.c -ldl -lpthread -lcrypto' || exit 1
    $RUN -v "idrive-rootfs-$NAME:/rootfs:ro" $HIMG \
        /rootfs/lib/ld-linux-x86-64.so.2 --library-path /rootfs/lib:/rootfs/usr/lib:/rootfs/usr/lib/cinemo \
        /re/out/harness/screen_b /rootfs/usr/lib/cinemo/libNmeCarPlay.so "$MODE" "$N" ;;
harness-setup)
    # hook111 (re/harness/hook111.c) through the library's own SETUP and /info entries
    NAME=${1:?name}
    HIMG=idrive-re-harness:18.04
    docker image inspect $HIMG >/dev/null 2>&1 || docker build --platform linux/amd64 -q -t $HIMG "$WIN_HERE/harness" >/dev/null
    mkdir -p "$HERE/out/harness"
    $RUN $HIMG sh -c 'gcc -O1 -g -Wall -o /re/out/harness/setup_b /re/harness/setup_b.c -ldl -lpthread -lcrypto' || exit 1
    $RUN -v "idrive-rootfs-$NAME:/rootfs:ro" $HIMG \
        /rootfs/lib/ld-linux-x86-64.so.2 --library-path /rootfs/lib:/rootfs/usr/lib:/rootfs/usr/lib/cinemo \
        /re/out/harness/setup_b /rootfs/usr/lib/cinemo/libNmeCarPlay.so ;;
harness-preload)
    # libhook111.so (re/harness/preload.c) loaded as on the car: LD_PRELOAD after
    # the unit's libschedconfig, the plugin dlopen'ed by a library
    NAME=${1:?name}
    HIMG=idrive-re-harness:18.04
    docker image inspect $HIMG >/dev/null 2>&1 || docker build --platform linux/amd64 -q -t $HIMG "$WIN_HERE/harness" >/dev/null
    mkdir -p "$HERE/out/harness"
    $RUN $HIMG sh -c '
        set -e; cd /re/out/harness
        gcc -O1 -g -Wall -shared -fPIC -fvisibility=hidden -o libhook111.so /re/harness/preload.c -ldl -lpthread
        gcc -O1 -shared -fPIC -o libstubloader.so /re/harness/stub_loader.c -ldl
        gcc -O1 -g -Wall -o preload_test /re/harness/preload_test.c -ldl
        echo "-- the stub, as libNmeBaseClasses.so:"; readelf -Ws --dyn-syms libstubloader.so | grep " UND dlopen"
        echo "-- libhook111.so exports:"; readelf -Ws --dyn-syms libhook111.so | grep -E " (dlopen|hook111_[a-z_]+)$" | awk "{print \$8}" | tr "\n" " "; echo' || exit 1
    LP=/rootfs/lib:/rootfs/usr/lib:/rootfs/usr/lib/cinemo
    rc=0
    for mode in on off wrong; do
        echo "== $mode"
        case $mode in
        on)    ENV="" PLUGIN=/rootfs/usr/lib/cinemo/libNmeCarPlay.so ;;
        off)   ENV="HOOK111_OFF=1" PLUGIN=/rootfs/usr/lib/cinemo/libNmeCarPlay.so ;;
        wrong) ENV="" PLUGIN=/tmp/other/libNmeCarPlay.so ;;
        esac
        $RUN -v "idrive-rootfs-$NAME:/rootfs:ro" $HIMG sh -c "
            mkdir -p /tmp/other && cp /rootfs/usr/lib/cinemo/libNmeAndroidAuto.so /tmp/other/libNmeCarPlay.so
            env $ENV LD_PRELOAD='/rootfs/usr/lib/libschedconfig.so.1 /re/out/harness/libhook111.so' \
                /rootfs/lib/ld-linux-x86-64.so.2 --library-path $LP \
                /re/out/harness/preload_test /re/out/harness/libstubloader.so $PLUGIN $mode" || rc=1
    done
    exit $rc ;;
deploy-test)
    # re/deploy/hook111/hook111-arm.sh on the unit's busybox and libc, fake systemctl
    NAME=${1:?name}
    HIMG=idrive-re-harness:18.04
    $RUN -v "idrive-rootfs-$NAME:/rootfs:ro" $HIMG sh -c '
        ln -sf /rootfs/lib/ld-linux-x86-64.so.2 /lib/ld-linux-x86-64.so.2
        export LD_LIBRARY_PATH=/rootfs/lib:/rootfs/usr/lib
        /rootfs/bin/busybox.nosuid sh /re/deploy/hook111/test/arm_test.sh /rootfs /re/deploy/hook111' ;;
harness-annexb)
    # the stream-111 output sink (re/harness/annexb.c): unit tests, then a real
    # x264 stream through it to a slow reader, decoded by ffmpeg. No BMW bytes.
    HIMG=idrive-re-harness:18.04; FIMG=idrive-re-harness:18.04-ffmpeg
    docker image inspect $HIMG >/dev/null 2>&1 || docker build --platform linux/amd64 -q -t $HIMG "$WIN_HERE/harness" >/dev/null
    docker image inspect $FIMG >/dev/null 2>&1 || docker build --platform linux/amd64 -q -t $FIMG -f "$WIN_HERE/harness/ffmpeg.Dockerfile" "$WIN_HERE/harness" >/dev/null
    mkdir -p "$HERE/out/harness"
    $RUN $FIMG sh -c '
        set -e
        gcc -O1 -g -Wall -o /re/out/harness/annexb_test /re/harness/annexb_test.c -lpthread
        /re/out/harness/annexb_test unit
        cd /re/out/harness
        ffmpeg -v error -y -f lavfi -i testsrc=size=1088x480:rate=30 -t 10 -vf noise=alls=12:allf=t -pix_fmt yuv420p -c:v libx264 -preset ultrafast -qp 24 \
            -x264-params keyint=30:min-keyint=30:scenecut=0:slices=1 -f h264 annexb_in.h264
        /re/out/harness/annexb_test decode annexb_in.h264 annexb_out.h264 >annexb_decode.log || { cat annexb_decode.log; echo "FAIL decode run"; exit 1; }
        cat annexb_decode.log
        sent=$(sed -n "s/^frames_out=//p" annexb_decode.log)
        ffmpeg -v error -f h264 -i annexb_out.h264 -f null - 2>annexb_ffmpeg.err || true
        got=$(ffprobe -v error -count_frames -select_streams v -show_entries stream=nb_read_frames -of csv=p=0 annexb_out.h264)
        echo "  ffmpeg: decoded $got frame(s) of $sent sent; errors: $(wc -l <annexb_ffmpeg.err) line(s)"
        head -5 annexb_ffmpeg.err
        if [ -s annexb_ffmpeg.err ] || [ "$got" != "$sent" ]; then echo "FAIL ffmpeg decode"; exit 1; fi
        echo "ok   ffmpeg decodes every frame sent, no errors"; echo PASS' ;;
selftest)
    $RUN "$IMAGE" sh /re/test/selftest.sh ;;
*)
    sed -n '2,16p' "$0"; exit 2 ;;
esac
