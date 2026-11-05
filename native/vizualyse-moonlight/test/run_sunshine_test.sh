#!/bin/sh
# Runs test/sunshine_test.js and test/server_test.js: Sunshine (test/sunshine)
# and the head unit in a box (test/unit) on their own Docker network. Needs
# build/moonlight-core and build/ffmpeg (sh build.sh). The head unit's
# container gets --privileged and the Docker host's /dev for virtual
# gamepads: an evdev one (test/uinput_pad.c, through /dev/uinput; NO_UINPUT=1
# leaves it out) and an XInput USB one read through usbfs as on the car
# (test/usbip_pad.c, through the kernel's vhci_hcd, loaded here if it can be;
# NO_USBIP=1 leaves it out).
#   sh native/vizualyse-moonlight/test/run_sunshine_test.sh
set -eu
export MSYS_NO_PATHCONV=1
HERE=$(cd "$(dirname "$0")/.." && pwd)
WIN_HERE=$(cd "$HERE" && (pwd -W 2>/dev/null || pwd))
NET=ml-test-$$
docker build -q -t ml-sunshine-test "$WIN_HERE/test/sunshine" >/dev/null
docker build -q -t ml-unit:18.04-node8 "$WIN_HERE/test/unit" >/dev/null
docker network create $NET >/dev/null
cleanup() { docker rm -f ml-sunshine-$$ >/dev/null 2>&1 || true; docker network rm $NET >/dev/null 2>&1 || true; }
trap cleanup EXIT
docker run -d --name ml-sunshine-$$ --network $NET ml-sunshine-test >/dev/null
IP=$(docker inspect -f "{{(index .NetworkSettings.Networks \"$NET\").IPAddress}}" ml-sunshine-$$)
# Sunshine is ready when it answers serverinfo
docker run --rm --network $NET ml-unit:18.04-node8 sh -c "for i in \$(seq 1 40); do curl -s -m 2 http://$IP:47989/serverinfo >/dev/null && exit 0; sleep 1; done; exit 1"
PADOPT=""
if [ "${NO_UINPUT:-}" != 1 ] && docker run --rm -v "$WIN_HERE:/m" -w /m idrive-moonlight-build:18.04-gcc8-fonts gcc-8 -O2 -Wall -Werror -o build/test-uinput-pad test/uinput_pad.c; then
    PADOPT="-e MOONLIGHT_TEST_PAD=/m/build/test-uinput-pad"
fi
if [ "${NO_USBIP:-}" != 1 ] && docker run --rm -v "$WIN_HERE:/m" -w /m idrive-moonlight-build:18.04-gcc8-fonts gcc-8 -O2 -Wall -Wextra -Werror -o build/test-usbip-pad test/usbip_pad.c; then
    # vhci_hcd is a module in Docker Desktop's (WSL 2) kernel: load it in the host's namespaces
    docker run --rm --privileged --pid=host alpine nsenter -t 1 -m -- modprobe vhci-hcd >/dev/null 2>&1 || true
    if docker run --rm --privileged alpine test -w /sys/devices/platform/vhci_hcd.0/attach; then
        PADOPT="$PADOPT -e MOONLIGHT_TEST_USBPAD=/m/build/test-usbip-pad"
    else
        echo "no vhci_hcd in the Docker host's kernel: the USB gamepad checks are skipped" >&2
    fi
fi
[ -n "$PADOPT" ] && PADOPT="--privileged -v /dev:/dev $PADOPT"
rc=0
docker run --rm --network $NET $PADOPT -v "$WIN_HERE:/m:ro" -w /m ml-unit:18.04-node8 sh -c "for t in ${TESTS:-sunshine server}; do node test/\${t}_test.js $IP || exit 1; done" || rc=$?
[ $rc = 0 ] || docker logs ml-sunshine-$$ 2>&1 | grep -vE "CAP_SYS_ADMIN|avahi|pulseaudio|audio capture" | grep -E "Error|Fatal|Warning|RTSP|rtsp|launch|Launch" | tail -30
exit $rc
