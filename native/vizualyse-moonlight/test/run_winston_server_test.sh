#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 Yousaf Khan
#
# Moonlight's Winston output end to end (test/winston_server_test.js): a real
# Sunshine (test/sunshine) and, on the same Docker network, the tool in the
# head unit's own root filesystem with the unit's own Winston beside it
# (tools/winston-bench, the stub GPU). Needs build/ (build.sh).
#   sh native/vizualyse-moonlight/test/run_winston_server_test.sh
# MOONLIGHT_TEST_DECODER=msdk-sw: the unit's software Media SDK (the GPU
# path's code) instead of libavcodec.
set -eu
export MSYS_NO_PATHCONV=1
HERE=$(cd "$(dirname "$0")/.." && pwd)
WIN_HERE=$(cd "$HERE" && (pwd -W 2>/dev/null || pwd))
node "$WIN_HERE/../../platform/platform.js" sync "$WIN_HERE" >&2
[ -f "$HERE/build/moonlight-core" ] || sh "$HERE/build.sh"
NET=ml-winston-$$
docker build -q -t ml-sunshine-test "$WIN_HERE/test/sunshine" >/dev/null
docker network create $NET >/dev/null
cleanup() { docker rm -f ml-sunshine-$$ >/dev/null 2>&1 || true; docker network rm $NET >/dev/null 2>&1 || true; }
trap cleanup EXIT
docker run -d --name ml-sunshine-$$ --network $NET ml-sunshine-test >/dev/null
IP=$(docker inspect -f "{{(index .NetworkSettings.Networks \"$NET\").IPAddress}}" ml-sunshine-$$)
docker build -q -t ml-unit:18.04-node8 "$WIN_HERE/test/unit" >/dev/null
docker run --rm --network $NET ml-unit:18.04-node8 sh -c "for i in \$(seq 1 40); do curl -s -m 2 http://$IP:47989/serverinfo >/dev/null && exit 0; sleep 1; done; exit 1"
BENCH_NETWORK=$NET DOCKER_ARGS="-v $WIN_HERE:/m:ro ${MOONLIGHT_TEST_DECODER:+-e MOONLIGHT_TEST_DECODER=$MOONLIGHT_TEST_DECODER}" WINSTON_ARGS="--param stdlog-level=3" \
    sh "$HERE/../../tools/winston-bench/run.sh" stub sh -c "mkdir -p /tmp && chmod 1777 /tmp && cd /m && /usr/bin/node test/winston_server_test.js $IP"
