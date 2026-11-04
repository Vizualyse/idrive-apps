# CarPlay second screen on the iDrive 7 MGU: progress report

Status as of 2026-11-04. Details and addresses: [findings-20.40.2.md](findings-20.40.2.md).
How to run everything: [README.md](README.md). Prior work by others: [references.md](references.md).

## The goal

Get CarPlay's instrument-cluster map (AirPlay screen stream 111, the "alternate
screen") onto this head unit. The unit runs `carplay` 20.40.2 with Cinemo's
`libNmeCarPlay.so`, which only supports the main screen. Every patch or piece of
reverse engineering must be testable off the car first.

---

## 1. Questions answered

| Question | Answer | Evidence |
|---|---|---|
| Can the 2020 library just be patched to switch the second screen on? | **No.** The code isn't there. SETUP accepts screen type 110 only; type 111 is logged as `Unsupported stream type`. None of the alternate-screen keys exist (`altScreen`, `viewAreas`, `safeArea`, `suggestUI`, `showUI`). | Ghidra, findings-20.40.2.md |
| Is swapping in the 2022 stack a proven failure? | **No, it's untested.** The line in `Learnings.md` was an inference and has been corrected. | git history: no experiment |
| What software is the car on? | `BMW MGU I_21w12.2-1-4` (built 2021-03-23). `carplay` and the Cinemo files date from 30 Sep 2020. | `/etc/os-release` on the unit |
| Can the 2022 binaries be obtained? | Not found publicly. "11/2022.60" isn't documented anywhere; bmw.com/update serves older head units only (the NHTSA bulletin says ID7 MGU is not covered). The realistic source is the upstream owners of 22.28.3 units. | web research |
| Do other makers use Cinemo with easier-to-get firmware? | None confirmed. It matters less now: Cinemo wraps **Apple's own AirPlay receiver code (`AirPlay/320.17.6`)**, the same code base as Harman's in the Audi project. | survey + Ghidra |
| Is the Audi MHI2-altScreen work relevant? | **Yes, very.** Same Apple code underneath, and our 110 SETUP path follows the steps they documented in the same order. The difference: Harman's build exports the function names, Cinemo's doesn't (35 exports), so we recover them from log strings. | references.md |
| Can a second screen object run alongside the first? | **Yes, structurally.** A screen is a self-contained allocation (`calloc 0x358` plus its own mutex). The single-screen limit is just one set of fields in the session. | `0x185440` and its methods |
| Where do frames go? | ScreenStream → Cinemo's one video sink per session (`ctx + 0x20`). They can be redirected per context by replacing four small ScreenStream functions. | decompile + harness |
| Which port can the second listener use? | **6031 is already open** (IPv4, `wlan_bridge`), along with 5000/5001/6030/7000. The main screen asks for 6030. IPv6 has no CarPlay ports, so CarPlay here runs on IPv4. | live `nft list ruleset` |

---

## 2. What was built (all off-car, in `re/`)

**Data pulled from the unit, read-only, stored outside the repo in `../idrive-rootfs/20.40.2/`:**

- `facts.txt`: versions, mounts, hashes of `carplay` and every Cinemo library,
  the running `carplay`'s command line, environment, loaded libraries and
  listening sockets.
- `rootfs.tar` (1.5 GB), unpacked into the docker volume `idrive-rootfs-20.40.2`.
- `nft-ruleset.txt`: the live firewall rules.

**Tooling:**

| File | Purpose |
|---|---|
| `pull_unit.sh`, `unit/facts.sh` | Read-only pull (takes `SSH_KEY`). Never stops or restarts `carplay`. |
| `docker/Dockerfile` | Analysis image `idrive-re:ghidra-12.1.4` (Ghidra checksum verified, JDK 21, binutils, pyelftools, gcc). |
| `survey.py` | Each binary's identity and how it loads (missing libraries, undefined versioned symbols), plus where the second-screen keywords appear. Also checks another firmware's binaries against this unit's root file system (the swap check). |
| `ghidra/ExportAltScreen.java` | Keyword → referencing functions, including Cinemo's encoded string constants (8-byte header `56 07 01 00 ff ff ff 7f`). Flags functions using both 110 and 111. Lists every function. |
| `ghidra/ExportLogNames.java` | Apple function names recovered from log strings (345 mapped). |
| `ghidra/Decompile.java`, `DecompileAll.java` | Decompiles chosen functions (`s:<addr>` reads strings), or all 1,857 functions into one greppable file. |
| `run.sh` | Wrappers: `build`, `extract`, `survey`, `ghidra`, `decompile`, `decompile-all`, `harness`, `harness-setup`, `harness-preload`, `harness-annexb`, `deploy-test`, `selftest`. |
| `test/selftest.sh` | Synthetic binaries, no BMW bytes. 12 checks, all pass. |
| `harness/Dockerfile` | Ubuntu 18.04 image matching the unit's glibc 2.27 and OpenSSL 1.1. `ffmpeg.Dockerfile` adds Ubuntu's ffmpeg, for tests only. |
| `harness/screen_b.c` | Runs a second screen inside the real library. **Passes.** |
| `harness/hook111.c` / `.h` | The hook as it would run in `carplay`: SETUP, TEARDOWN, `/info`, session commands, frames. **Passes.** |
| `harness/setup_b.c` | Drives `hook111` through the library's own SETUP, TEARDOWN, `/info` and session-control entries. **35 checks pass.** |
| `harness/annexb.c` / `.h`, `sink_annexb.c` | Screen B's sink: Annex-B H.264 to `127.0.0.1:6111`, never blocking; asks for a keyframe when needed. `annexb_test.c`: **18 checks pass**, and ffmpeg decodes a real x264 stream sent through it. |
| `harness/preload.c` | `libhook111.so`: installs the hook when Cinemo `dlopen`s the plugin. `preload_test.c` / `stub_loader.c`: **23 checks pass** under the unit's loader. |
| `deploy/hook111/` | Arm step (`hook111-arm.sh`, busybox ash), its units and drop-ins, a mgu-deploy `component.json` (draft). `test/arm_test.sh`: **34 checks pass** on the unit's busybox. |

**Documents:** `README.md` (steps), `references.md` (Audi work, our
waze-on-cluster history, AirPlay references, corrected after the survey),
`findings-20.40.2.md` (every address and finding, with how it was established).

---

## 3. What the harnesses established

`re/run.sh harness 20.40.2 <mode>` runs a second screen object inside the
**unit's real `libNmeCarPlay.so`**, under the unit's own loader and libraries,
after checking the build-id. A thread plays the phone.

| Mode | Result |
|---|---|
| `aes` | Pass: AVCC and 12/12 frames decrypted byte-exact into our sink; Cinemo's sink never touched. |
| `chacha` | Pass: the same through ChaCha20-Poly1305 (the pair-verify path real wireless CarPlay uses). |
| `chacha-tamper` | Pass: the corrupted frame and **every later frame** are rejected, because the nonce only advances on frames that authenticate. One error on stream 111 is fatal, so the stream must be torn down and set up again. |

**Wire format confirmed:**

- 128-byte header: u32 size, u8 opcode (0 frame, 1 config), u8 flags at +6,
  u64 timestamp at +8, float width/height at +0x10/+0x14.
- Config (AVCC) messages aren't encrypted.
- ChaCha20-Poly1305 per RFC 7539: nonce = 4 zero bytes + an 8-byte
  little-endian frame counter; AAD = the header, with its size field counting
  the tag.
- AES-128-CTR with a 128-bit big-endian counter.

**From the Audi project's logs and hook strings (not yet verified on our unit):**

- SETUP must answer `enabledFeatures: [altScreen, viewAreas]`.
- `/info` gets a second display record cloned from the first: new `uuid`,
  cluster size, `maxFPS`, `features=2`, `initialURL`,
  `altScreenSuggestUIURLs`, `viewAreas` / `initialViewArea`, and a
  `primaryInputDevice` pointing at a cloned HID device.

`re/run.sh harness-setup 20.40.2` runs `hook111` as installed in `carplay`
(trampolines, so stock code still runs) through the library's own SETUP
(`0x180670`) and `/info` (`0x10d270`) entries. **Pass, 3/3 runs:**

- SETUP with `{type:111, streamConnectionID}` returns 0, and the response has
  `{type:111, dataPort:6031}` and `enabledFeatures [altScreen, viewAreas]`.
  The stock code still logs and skips 111, in both the session layer and
  Cinemo's `_SetUpStreams`.
- The phone connects to 6031, derives the key itself from
  `streamConnectionID` (AirPlayStreamKey/IV), and sends AVCC + 10 AES-CTR
  frames. All 10 reach the sink byte-exact; start and stop are each seen once.
- `/info` `displays` returns the stock record from the configuration, plus
  hook111's (1088x480, `features=2`, 3 `altScreenSuggestUIURLs`).

Added on 2026-11-04, the same harness:

- **Lifecycle.** A repeat SETUP replaces screen B (6031 again). `TEARDOWN
  {111}` mid-stream takes 1 ms, through the stock quit (`User quit event
  received`). A full TEARDOWN while screen B still waits in accept takes
  10 ms, not the 10 s accept timeout. The port is free after each.
- **Pair-verify key path.** A PairingSession at `session+0x498` (type 3,
  state 5, secret at `+0x1ba`): the phone derives the key with HKDF-SHA512
  (`DataStream-Salt<connID>`, `DataStream-Output-Encryption-Key`) and sends
  8 ChaCha20-Poly1305 frames. All 8 arrive byte-exact.
- **Session commands.** The phone's `suggestUI` (through
  `AirPlayReceiverSessionControl`, as `/command` delivers it) is answered with
  `showUI` (url, uuid). The phone gets it as a binary-plist `POST /command` on
  the events connection, as the library sends `requestUI`. `forceKeyFrame`
  goes the same way, at most once a second. Other commands still reach the
  stock code.

`re/run.sh harness-annexb`: the sink on its own, plus a real stream. It never
blocks (worst call 0.6 ms; with a reconnect, under 1 ms after rate-limiting),
never cuts a NAL unit, and resumes only at an IDR, with SPS/PPS before it.
A 1088x480 x264 stream went to a reader at 60 % of its rate: 250 of 300 frames
dropped, and ffmpeg decoded all 50 that were sent, with no errors.

`re/run.sh harness-preload 20.40.2`: `libhook111.so` preloaded after the
unit's own `libschedconfig.so.1`, under the unit's loader. It installs right
after a library's `dlopen` of `libNmeCarPlay.so`, as Cinemo's
`libNmeBaseClasses.so` loads it. It refuses another build under that name and
does nothing when off. Other `dlopen`s are untouched.

`re/run.sh deploy-test 20.40.2`: the arm step on the unit's busybox and libc,
over simulated boots: crashes at load, crashes after it was healthy, lost
power, clean shutdowns, a changed library, a missing preload, a hanging
`systemctl`, bad config, a corrupt state file, a state file that can't be
saved.

---

## 4. Changes made on the car

**Port 22 fix.**

- **Cause:** the MGU-SSH tool's firewall keeper checked for
  `tcp dport 22 accept`, but `nft` prints `tcp dport ssh accept`. It inserted a
  duplicate rule every 15 seconds, and its `status` and `remove` commands had
  the same mismatch.
- **Fixed in** `Downloads/MGU-SSH/sshd-always-on.sh` (original kept as
  `.orig`). It now matches both spellings, and the keeper deletes extra copies.
- **Tested off-car first** against a fake `nft` (9/9 checks), then installed
  with the tool's own `install`.
- **Result:** 641 duplicates per chain down to one each, holding across keeper
  cycles, and `/` remounted read-only afterwards.

Nothing else on the unit was changed. Everything else was read-only.

---

## 5. Corrections along the way

- **The 2022 swap is untested**, not a proven failure. It had been stated as fact.
- **The Audi approach does transfer.** It was first judged not to, before the
  survey showed the shared Apple code.
- **bmw.com/update doesn't serve the iDrive 7 MGU.** It had been implied it might.
- **`FUN_00166c40` was a false positive** for 110/111: it's a hash function.
- **Harness bugs caught and fixed:** an AES init mix-up and a string-escaping
  slip in the harness code.
- **Two blocks by a safety classifier** (2026-11-03): once while working on the
  SETUP harness crash, and once during a commit attempt. No reason was given,
  neither was retried, and nothing was committed.
- **The SETUP harness crash was the harness, not the hook** (2026-11-03): see §6.2.
- **Found by the 2026-11-04 tests, fixed before anything reached a car:**
  - screen B was never torn down (thread detached, objects leaked), and it
    would have outlived the session clock it reads;
  - the library's accept helper can't be woken: after `shutdown()` it spins
    forever, so screen B has its own accept;
  - the arm step never armed when there was no config file (a shell exit
    status);
  - `run.sh harness-annexb` reported PASS over a failed check (a lost exit
    status in a pipe).

---

## 6. Left to do, in order

1. **Commit.** Everything under `re/` passes its tests.
2. ~~**Finish the SETUP and `/info` harness.**~~ Done 2026-11-03 (§3). The
   crash was the harness, not the hook: the fake session lacked what the
   constructor `0x17e0f0` sets (fds at -1, `+0x490 = 1`) and Cinemo's
   platform object at `+0x20`; then the fake configuration item was the
   wrong size (0x48 bytes) and overwrote the stack canary. Still not covered
   by it: a SETUP that mixes 111 with 110 or audio streams (that takes the
   non-idle path, with timing negotiation), the pair-verify key path (item 5),
   and `primaryInputDevice` / `viewAreas` in the second record (item 4).
3. ~~**Unread pieces.**~~ Done 2026-11-04. The `+0x10` callback is dead in
   this build (written once, never read). Teardown is wired for screen B
   (findings, "Screen B's life").
4. **Unknowns that may need the phone:**
   - the exact `viewAreas` / `safeArea` structure;
   - whether `/info` needs a top-level `altScreen` marker;
   - the cloned HID device for `primaryInputDevice`;
   - the shape of the stream-111 SETUP response (stock-style, or the request
     cloned with `streamID`);
   - **new:** what `suggestUI` carries, and the keys `showUI` wants (the hook
     sends `url` + `uuid`; one `#define` each in `hook111.c`);
   - **new:** whether `forceKeyFrame` with no params refreshes stream 111, or
     needs the stream named. Without a keyframe on request, a drop freezes the
     cluster until the phone's next IDR.
5. ~~**The pair-verify key path.**~~ Done 2026-11-04 (§3).
6. **Session commands.** Done: the mechanism (`suggestUI` → `showUI`,
   `hook111_send_command` for anything else), tested to the phone's socket.
   Left: `updateViewArea` / `adjacentViewAreas` / `changeMapZoomLevel`
   content, which waits on item 4.
7. **Output sink.** Done: `sink_annexb.c` → `127.0.0.1:6111`. Left: the
   consumer. vizualyse-cast's ffmpeg → cluster-render path with
   `-f h264 -i tcp://127.0.0.1:6111?listen` as its input (`map` target, width
   a multiple of 4, within 5500 KB/s).
8. **Loading into `carplay`.** Built and tested off-car: `libhook111.so`, the
   arm step, units, drop-ins (`deploy/hook111/`). Nothing on `/` changes: a
   static drop-in reads `/run/hook111/env`, which only the arm step writes, so
   every reboot starts stock until it arms again. Off after 2 failed starts.
   Built with the repo's packer:
   `node release/tool_artifact.js re/deploy/hook111 --out <dir>` runs
   `build.sh` (gcc in the glibc-2.27 image) and gives `hook111@0.0.1.tgz`,
   byte-identical across two builds. The library needs nothing newer than
   GLIBC_2.17, and exports only `dlopen` and `hook111_preload_state`. The
   shipped `.so` passes the preload test. It stays out of `native/` on
   purpose: `release.js` publishes every `native/` tool on a full release,
   and this one hasn't run on a car.
   For the first car runs, the hook writes every SETUP request and response,
   phone command, TEARDOWN, `/info` displays and sent command as a binary
   plist to `/run/hook111/log/<nnn>-<what>.bplist` (at most 500). The arm step
   creates that directory, owned by `carplay`'s user. Pull the files and read
   them with Python's `plistlib`.
   Not done:
   - an install by mgu-deploy, which also adds `hook111-arm` /
     `hook111-health` to recmgr's lists;
   - `systemd-analyze verify` of the units on the unit.
9. **First car test**, with a phone (MFi authentication can't be emulated).
   Before the first armed boot:
   - check `getcap /usr/bin/carplay` is empty (`carplay` runs as `cia_13002`,
     and file capabilities would make glibc ignore the preload);
   - check that `cia_13002` can read `/var/opt/hook111/current/libhook111.so`;
   - check nothing else on the unit uses 127.0.0.1:6111;
   - start with `hook111-arm.sh disable`, then `enable` and reboot (never
     restart `carplay`);
   - watch `journalctl -u carplay` for `[hook111]`, and run
     `hook111-arm.sh status`.
10. **In parallel:** ask the upstream owners for the 22.28.3 `carplay` and
    Cinemo files plus their I-step. Then run the survey's swap check, and diff
    the two libraries in Ghidra to see exactly what Cinemo added for the second
    screen.

---

## 7. Risks to keep in mind

- **Cluster take-over has broken the cluster before,** until a full car
  restart (see `Learnings.md`). The first live tests should run with
  navigation active or the cluster's central area off.
- **A crash in the hook takes down `carplay`, and with it the head unit.** The
  prologue and build-id checks refuse to install on anything unexpected. The
  arm step limits a crash loop to two reboots, then `carplay` starts stock.
  That holds only if the arm step and its `var-opt-ro` mark run as tested,
  which hasn't been seen on the unit yet.
- **A partial install.** `hook111_install` patches the four ScreenStream
  functions before the three entries. If `mprotect` failed partway (an LSM
  policy, say), the ScreenStream replacements would be live without the rest.
  They behave like stock for every context but screen B's, so that should be
  harmless, but it hasn't been tested.
- **The phone may not request stream 111** even with everything advertised.
  The Audi project hit exactly this ("advertised but phone never requests
  stream 111") and solved it with `enabledFeatures` plus `features=2`.
