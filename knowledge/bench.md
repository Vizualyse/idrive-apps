# Working on the bench

Measured on one unit (head unit software `I_21w12.2-1-4`) unless a line says otherwise. Index: [index.md](index.md).

- Test frames and filter graphs on a PC first: a still from
  `winston-grabber -n 1 x.jpg` or a few seconds of its UDP stream through the
  same ffmpeg build in a Linux container, then the unit.
- Looped or generated ffmpeg inputs never end: a test with them can write
  gigabytes; bound every test run.
- Off-car aids in the reference repos ([reference-repos.md](reference-repos.md)):
  mgu-render's `--replay FILE --out F.pam` (renders a recorded client stream
  offscreen), the firmware's software Media SDK `libmfxsw64` in Docker for
  decoder tests (upstream), idrive7-apps' head-unit stub (`kit/tools/hu-stub.js`),
  and mgu-store's read-only `probe.js` for what the image has.
