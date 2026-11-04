# Test-only: the harness image plus Ubuntu 18.04's ffmpeg (libx264), to make a
# real H.264 stream for annexb_test and to decode what the sink sends. Not
# used to build anything that runs on the unit.
FROM idrive-re-harness:18.04
RUN apt-get update -qq \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends ffmpeg >/dev/null \
 && rm -rf /var/lib/apt/lists/*
