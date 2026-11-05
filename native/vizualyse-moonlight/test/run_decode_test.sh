#!/bin/sh
# The decoders off the car: the GPU's code on the unit's own software Media
# SDK (test/firmware, extract.sh), and the built-in FFmpeg. A busy
# 1280x720@60 test pattern (moving, with fresh noise in every frame, as a
# game; 4 slices, no B frames, as Sunshine sends) is encoded
# with the static ffmpeg (tools/fetch_ffmpeg.js; only the tests use it), then
# build/decode_test in the head unit's box (test/unit) with:
#   - av: the built-in libavcodec: every picture equal to ffmpeg's decode;
#   - msdk-sw: the unit's software Media SDK, the GPU path's code (VPP and
#     all): equal to ffmpeg's decode too;
#   - both scaled to the cluster's 640x360 and the HUD's 480x270, against
#     each other (VPP's scaler and ours; above 25 dB on the noise, the worst
#     case for 2.67:1 bilinear);
#   - a picture for every 3rd frame only (behind): those equal to the
#     reference's;
#   - msdk: the unit's GPU library and libva load and give every symbol we
#     use (no GPU here: it gets as far as the render node).
# Needs sh build.sh first.
#   sh native/vizualyse-moonlight/test/run_decode_test.sh
set -eu
export MSYS_NO_PATHCONV=1
HERE=$(cd "$(dirname "$0")/.." && pwd)
WIN_HERE=$(cd "$HERE" && (pwd -W 2>/dev/null || pwd))
[ -f "$HERE/test/firmware/lib/libmfxsw64.so" ] || sh "$HERE/test/firmware/extract.sh"
(cd "$HERE" && node tools/fetch_ffmpeg.js)
docker build -q -t ml-unit:18.04-node8 "$WIN_HERE/test/unit" >/dev/null
docker run --rm -v "$WIN_HERE:/m" -w /m ml-unit:18.04-node8 sh -c '
    set -e
    T=/tmp/dec; mkdir -p $T
    F=/m/test/firmware/lib
    export MOONLIGHT_MSDK_DIR=$F LD_LIBRARY_PATH=$F
    build/ffmpeg -loglevel error -f lavfi -i "testsrc2=s=1280x720:r=60,noise=alls=30:allf=t" -t 4 \
        -c:v libx264 -preset ultrafast -tune zerolatency -bf 0 -g 120 -b:v 10M -pix_fmt yuv420p \
        -x264-params aud=1:slices=4 -f h264 $T/in.h264
    build/ffmpeg -loglevel error -i $T/in.h264 -f rawvideo -pix_fmt yuv420p $T/ref.yuv
    fail=0
    check() { # name, json, condition (node expression on r)
        node -e "const r = $2; const ok = $3; console.log((ok ? \"ok   \" : \"FAIL \") + \"$1 \" + JSON.stringify(r)); process.exit(ok ? 0 : 1)" || fail=1
    }
    for d in av msdk-sw; do
        r=$(build/decode_test $d $T/in.h264 $T/$d.yuv 1280 720)
        check "$d decodes all 240 frames" "$r" "r.aus === 240 && r.pictures === 240 && r.failed === 0"
        check "$d: every picture equal to ffmpeg'"'"'s" "$(node test/decode_compare.js $T/$d.yuv $T/ref.yuv 1280 720)" "r.frames === 240 && r.equal === 240"
        r=$(build/decode_test $d $T/in.h264 $T/$d-3.yuv 1280 720 3)
        check "$d behind: a picture for every 3rd frame" "$r" "r.pictures === 80 && r.failed === 0"
        check "$d behind: those equal to ffmpeg'"'"'s" "$(node test/decode_compare.js $T/$d-3.yuv $T/ref.yuv 1280 720 3)" "r.frames === 80 && r.equal === 80"
        for s in 640x360 480x270; do
            build/decode_test $d $T/in.h264 $T/$d-$s.yuv ${s%x*} ${s#*x} >/dev/null
        done
    done
    r=$(MOONLIGHT_RENDER_NODE=/nonexistent build/decode_test msdk $T/in.h264 /dev/null 1280 720 2>&1 || true)
    case $r in *"/nonexistent: No such file"*) echo "ok   msdk: the GPU library and libva load, every symbol found";;
        *) echo "FAIL msdk: $r"; fail=1;; esac
    for s in 640x360 480x270; do
        check "scaled to $s: av and msdk-sw alike" "$(node test/decode_compare.js $T/av-$s.yuv $T/msdk-sw-$s.yuv ${s%x*} ${s#*x})" "r.frames === 240 && (r.minPsnr === null || r.minPsnr > 25)"
    done
    exit $fail'
