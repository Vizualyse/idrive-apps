# Sound

Measured on one unit (head unit software `I_21w12.2-1-4`) unless a line says otherwise. Index: [index.md](index.md).

- Every source writes to a named SmartXbar input (`smartx:<name>`); the
  audio manager decides which reaches the speakers. `CarPlayMain_CF_48_STEREO`
  plays while CarPlay is (or nothing else is) the source.
- No `aplay` on the unit: Python (mgu-python 3.12) with ctypes and
  libasound works with nothing to compile.
- The first open of an input after boot can take a long time to connect
  (2 s of audio took 52 s once); after that it is real time.
- So a live stream must drop, not queue: Moonlight 0.1.1 wrote every sample
  and the game's sound stayed seconds behind the picture after such a stall
  (2026-11-05). `pcm_play.py --live` reads its input empty, keeps the device
  60 ms full and drops what waits beyond 60 ms. `snd_pcm_set_params` starts
  playback only once the whole buffer is full, so a device kept part full
  needs a lower start threshold (sw params).
- *(ref: IterioDev, an iDrive 8 SDK config in a bundle)* oap-sdk has an
  OAP **media player** (`mediaPlayer` settings; instances `OapGenericMedia`
  entertainment, `OapGenericOverlay`, `OapGenericInterrupt`). It may be how
  an app becomes a real entertainment source with the iDrive volume on it:
  look for `OapGenericMedia` / `mediaPlayer` in the unit's oap-sdk 24.x and
  `/etc/oap/someip/someip-interfaces.json`. The SDK's `registerAudioFocus()`
  only sets a status. A root tool can reach SOME/IP services through
  `/usr/lib/someip.node` ([vehicle-data.md](vehicle-data.md)).
- *(ref: upstream)* Wireless CarPlay on 2.4 GHz plus a cluster stream made
  the sound cut out; everything runs at nice 0 so nothing starves CarPlay's
  audio threads.
