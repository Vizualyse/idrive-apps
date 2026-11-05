#!/bin/sh
# A stand-in for mgu-python playing pcm_play.py in the off-car tests: the
# audio goes to MOONLIGHT_TEST_PCM.
exec cat >> "${MOONLIGHT_TEST_PCM:-/dev/null}"
