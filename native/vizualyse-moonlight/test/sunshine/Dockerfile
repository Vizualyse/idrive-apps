# The off-car GameStream host for the tests: Sunshine (LizardByte's image,
# pinned) on a virtual X display (Xvfb) with a moving test picture, encoding
# in software (libx264), with PulseAudio on a null sink for its sound.
# Built and run by test/run_sunshine_test.sh.
FROM lizardbyte/sunshine@sha256:a0872a4c9091c46096325f01291c014b6f72696934258ceb99550393440ede11
USER root
RUN apt-get update -qq \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends xvfb x11-apps pulseaudio pulseaudio-utils >/dev/null \
 && rm -rf /var/lib/apt/lists/*
COPY run.sh /run.sh
COPY sunshine.conf apps.json /seed/
RUN chmod 755 /run.sh
USER lizard
ENTRYPOINT ["/run.sh"]
