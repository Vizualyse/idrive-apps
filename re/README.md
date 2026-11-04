# Reverse-engineering CarPlay's second screen

Goal: the CarPlay instrument-cluster map (AirPlay screen stream 111) on this
unit's CarPlay, `carplay` 20.40.2 with Cinemo's `libNmeCarPlay.so`. What is
known so far, and from where: [references.md](references.md).

**Rule: everything we build here runs off the car first.** The unit is
x86-64, so its own binaries run in a `linux/amd64` container with no
emulator. Only a live phone session needs the car (MFi authentication).

**No BMW or Cinemo bytes in this repository.** Root file systems live
outside it (`../idrive-rootfs/`) and in docker volumes; results go to
`re/out/` (git-ignored).

## Steps

1. **Pull** (read-only on the unit; never stops or restarts `carplay`):

   ```sh
   re/pull_unit.sh <unit-host>      # -> ../idrive-rootfs/<version>/{facts.txt,rootfs.tar}
   ```

2. **Unpack and survey** (off-car):

   ```sh
   re/run.sh build                                   # once: the idrive-re image, Ghidra 12.1.4
   re/run.sh extract ../idrive-rootfs/20.40.2/rootfs.tar 20.40.2
   re/run.sh survey 20.40.2                          # carplay + every libNme*: identity, loading, vocabulary
   ```

   For another firmware's `carplay` or library, `re/run.sh survey 20.40.2 <file>`
   checks it against this unit's root file system: missing libraries and
   undefined symbols. That is the swap check.

3. **Ghidra** (off-car):

   ```sh
   re/run.sh ghidra 20.40.2 /usr/lib/libNmeCarPlay.so   # path as on the unit
   ```

   `re/out/<name>/<file>.tsv`: each piece of the second-screen vocabulary and
   the functions that use it (`kw`), functions that test both 110 and 111
   (`scalar`), and every function (`func`, for comparing builds).

4. **Decide** from 2 and 3 (see references.md, "the question for 20.40.2"):
   - The code is present but unused → ungate it, as waze-on-cluster did in
     22.28.3.
   - Parts of it exist (a per-stream setup that takes a type, key derivation
     per stream) → a hook that drives them for 111, as the Audi project did.
   - None of it exists → building the subsystem. Weigh against the swap.

5. **Harness** (off-car, the unit's real libraries):

   ```sh
   re/run.sh harness 20.40.2 aes|chacha|chacha-tamper
   ```

   Runs a second screen object inside the unit's `libNmeCarPlay.so`, under the
   unit's own loader, with its frames redirected to a test sink
   ([findings](findings-20.40.2.md#proven-off-car-a-second-screen-in-the-real-library-harness-2026-11-03)).

   ```sh
   re/run.sh harness-setup 20.40.2     # hook111 through the library's SETUP, TEARDOWN, /info, /command
   re/run.sh harness-preload 20.40.2   # libhook111.so loaded as in carplay (LD_PRELOAD, plugin dlopen)
   re/run.sh harness-annexb            # the Annex-B sink; ffmpeg decodes what it sends (no BMW bytes)
   re/run.sh deploy-test 20.40.2       # the arm step (deploy/hook111) on the unit's busybox
   ```

   Where it stands and what's left: [STATUS.md](STATUS.md).

## Tests

```sh
re/run.sh selftest
```

Builds synthetic binaries (a "2020" library with one screen, a "2022" one
with `altScreen`, a 110/111 switch and a new symbol, and a newer `carplay` with
an extra library). It checks the survey and the Ghidra export report exactly
those, including the swap check's missing library and undefined symbols.
