# Input (touch, the iDrive controller, gamepads)

Index: [index.md](index.md).

## Touch

- See [central-screen.md](central-screen.md): 112-byte PDUs from
  160.48.199.115 to UDP 30567 on vlan73; a root tool can read a copy
  (AF_PACKET). We found X at 54 and Y at 60 on iDrive 7.
- *(ref: IterioDev `screencast.js:243-282`)* The same offsets are what
  IterioDev calls the "Hmi8" layout, and inject touches with it (UDP to
  127.0.0.1:30567, or to a running renderer's port: 30570 mgu-render).
  The 16-byte difference we saw is probably in how mgu-render parses the
  packet, not in the PDU. PDU: u32BE `0xB0048002`, u32BE 96, payload at 16:
  `[28]=0x80`, `[53]` finger count, X u16BE 54, Y 60, `[62]=50`,
  `[63]=event<<4` (1 down, 2 move, 3 up).
- Renderers divert the display's touches with nft rules matching only the
  display's packets; on some MainApp 6.5.5 cars `nft` can't read a script
  from `-` (use `nft -f file`).

## The iDrive controller *(ref: idrive7-apps)*

- FrontCCU is SOME/IP service **0xb508**. Event 0x8002
  `statusRotaryEncoderState`: [0] seq, [1-2] knob counter BE (wraps), [3]
  press (short/long), [4] tilt (north/east/south/west, centre); 15 invalid.
  Event 0x8001: the push buttons (`README.md:891-892`, `apps/doom/controls.js:20-25`).
- The HOME / BACK keys and the controller only reach RHMI states, not
  renderer layers. idrive7-apps' `mgu-inputgate.so` (a Store tool, preloaded
  into HmiMain3D behind a strike guard) hides the knob from the HMI while a
  renderer app wants it and forwards it (`kit/renderd/README.md:243-277`).
  Without it the HMI reacts too (push forward opens its pull-down).
- From an app without the gate *(ref: mgu-store `apps/robertn_store/src/store.js:411-422`)*:
  manifest `"de.bmw.infotainment.controlelements.FrontCCU": {"instances": ["1"], "attributes": {"statusRotaryEncoderState": "rs"}}`,
  then `buildTypedProxy` → `init()` → `waitUntilAvailable()` →
  `statusRotaryEncoderState.subscribe`. Fields `frontRotaryEncoderOperation`
  (u16, 0xffff invalid), `frontRotaryEncoderPushButton`
  (`DREHGEBER_KURZ_GEDRUECKT` / `_LANG_` or 1/2), steps
  `((to - from + 0x18000) % 0x10000) - 0x8000`, ignoring jumps over 24.

## Gamepads

- No evdev / HID / uinput in the car's kernel; XInput USB pads through usbfs
  (`native/vizualyse-moonlight/README.md`). Nobody else reads gamepads on
  the unit.
