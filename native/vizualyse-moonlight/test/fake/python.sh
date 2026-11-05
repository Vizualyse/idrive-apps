#!/bin/sh
# A stand-in for mgu-python playing pcm_play.py in the off-car tests: the
# audio goes to MOONLIGHT_TEST_PCM. It ignores SIGTERM, as the real player
# does while blocked in an ALSA write, and leaves its pid for the test.
echo $$ >> "${MOONLIGHT_TEST_PCM:-/dev/null}.pids"
trap '' TERM
exec cat >> "${MOONLIGHT_TEST_PCM:-/dev/null}"
