# tool/pcm_play

A version is frozen once a newer one exists. A component moves to a new
one with `node platform/platform.js use tool/pcm_play <version>`.

## 1.0.0

`pcm_play.py`, the PCM player through SmartX, and its test
`test/pcm_play_test.py`, as they were on main at 68aa156: from
vizualyse-moonlight and vizualyse-steam. vizualyse-cast had an older copy
that predated the SmartX lock fix (2026-11-05: a lock first made by root
silenced CarPlay until a restart); on this version it plays through the
fixed one.
