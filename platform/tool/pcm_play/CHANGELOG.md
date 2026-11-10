# tool/pcm_play

A version is frozen once a newer one exists. A component moves to a new
one with `node platform/platform.js use tool/pcm_play <version>`.

## 1.0.1

- (what changed, and which components it affects)

## 1.0.1

The SmartX lock fix now works: 1.0.0 looked up a user `ent_alsa`, which the
unit doesn't have (the system's account is `ent_alsaroutingadapters`; `ls`
cuts it to 8 characters), so `prepare_lock()` returned without making or
setting back a lock, and a stream first opened by our player still left a
root-owned 0640 lock (2026-11-05: CarPlay silent until a restart). The lock
now takes the owner and group of `/run/smartx` itself
(`ent_alsaroutingadapters:mgu_alsa`, from the system's tmpfiles.d), 0660;
nothing when that folder is root's. Found in the emulator (2026-11-10). The
test no longer makes an `ent_alsa` user, which had hidden it. Affects
every component on 1.0.0 (vizualyse-moonlight, vizualyse-steam,
vizualyse-cast) once moved here.

## 1.0.0

`pcm_play.py`, the PCM player through SmartX, and its test
`test/pcm_play_test.py`, as they were on main at 68aa156: from
vizualyse-moonlight and vizualyse-steam. vizualyse-cast had an older copy
that predated the SmartX lock fix (2026-11-05: a lock first made by root
silenced CarPlay until a restart); on this version it plays through the
fixed one.
