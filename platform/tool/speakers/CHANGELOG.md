# tool/speakers

A version is frozen once a newer one exists. A component moves to a new
one with `node platform/platform.js use tool/speakers <version>`.

## 1.0.0

New: `speakers.js`, the car's speakers for a tool's sound with the iDrive
volume on it and no CarPlay phone: `claim()` marks CarLife's media source
(287) available and connects it to MediaSink_Front, resolving with the
SmartX device to play into (`smartx:CarLifeMedia_CF_48_STEREO`, through
`tool/pcm_play` 1.0.1); `release()` gives the speakers back to the source
that had them (the radio if none); a `lost` event when something else takes
them. `claimOr(fallback)` plays into CarPlay's input (as before) when the
speakers can't be had; several tools may hold them at once
(`/run/vizualyse-speakers.json`, the last gives them back); `recover()` at a
tool's start gives back what a dead tool or a head unit restart left
claimed; a release during a claim waits for it. Builds its SOME/IP schemas
from the unit's own catalog at start (no BMW definitions shipped). Its test
(`test/speakers_test.js`, Node 8, CI) runs against a fake audio manager;
the real one in the emulator (`tools/am-source`, knowledge/sound.md). Used
by vizualyse-moonlight 0.2.6, vizualyse-steam 0.2.2, vizualyse-cast 0.3.12;
not yet tried on the car.
