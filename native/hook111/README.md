# hook111: CarPlay cluster map (stream 111)

**Experimental.** A library preloaded into the head unit's stock `carplay`
20.40.2 (Cinemo `libNmeCarPlay.so`, which supports one screen) that adds
CarPlay's second screen: the phone's instrument-cluster view, AirPlay screen
stream 111. It hands the stream out as Annex-B H.264 on `127.0.0.1:6111`, where
Cast to cluster (`native/vizualyse-cast`) reads it for the cluster map or the
HUD. How it was found and what the car showed: [`re/STATUS.md`](../../re/STATUS.md).

Only for this build of `carplay`: the hook checks the library's sha256 and
build-id and stays out of anything else.

## On the unit

Nothing on `/` changes. At every start `hook111-arm.service` (before
`carplay`) decides whether to arm the hook: it writes `/run/hook111/env`, which
`carplay`'s drop-in reads, so every reboot starts stock unless it arms again.
After two failed starts in a row (a crash seen by `hook111-health`, or no
healthy mark) `carplay` starts stock until `reset`.

```sh
/var/opt/hook111/current/hook111-arm.sh status    # this start, the last ones, the mode
/var/opt/hook111/current/hook111-arm.sh mode alt  # off (as stock) | alt (second screen) | full
/var/opt/hook111/current/hook111-arm.sh disable   # stock from the next start; enable / reset
```

A fresh install arms in mode `off`: the hook is loaded but answers the phone
as stock. `alt` offers the second screen from the phone's next connection.
`full` also offers `viewAreas`, which the phone refused on the car: don't use
it. The mode applies at once (the hook reads it at each SETUP); never restart
`carplay` by hand. `/run/hook111/log/` holds the status file and a plist log
of the session (at most 500 files).

## Build and test

```sh
sh native/hook111/build.sh                     # build/libhook111.so, in image/Dockerfile (glibc 2.27)
node release/release.js check hook111          # two clean kit builds, compared byte for byte
re/run.sh harness-setup 20.40.2                # these sources in the unit's real library
re/run.sh harness-preload 20.40.2
re/run.sh harness-annexb
re/run.sh deploy-test 20.40.2                  # hook111-arm.sh on the unit's busybox
```

The `re/` tests need the unit's root file system in a docker volume
(`re/README.md`); no BMW or Cinemo bytes are in this repository.
`bench/make_command.py` writes a command for the bench channel.
