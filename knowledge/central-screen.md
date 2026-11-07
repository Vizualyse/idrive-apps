# The central screen (mgu-render)

Measured on one unit (head unit software `I_21w12.2-1-4`) unless a line says otherwise. Index: [index.md](index.md).

- **mgu-render** draws on the central display: video through a frame file
  (`/dev/shm/mgu-video-<name>`, a 64-byte "MGVF" header and 3 I420 slots)
  plus a draw op at least once a second. Root clients are exempt from its
  foreground gate. Worked on this unit (its docs listed iDrive 7 video as
  untested).
- mgu-render's app area is 1790x638 at +108+82 of the 1920x720 screen (the
  HMI's top bar and left strip outside it). A layer placed at 0,0 1920x720
  covers the whole screen, HMI included.
- mgu-render decodes touch PDUs in iDrive 8's layout: on iDrive 7 the fields
  sit 16 bytes later (X u16 BE at 54, Y at 60, the event in the high nibble
  of 63; 112-byte PDUs every 8 ms while a finger is down, from
  160.48.199.115 to UDP 30567 on vlan73), so a CLAIM gets no touch here. A
  root tool can read a copy of them passively (AF_PACKET on vlan73).
- An iDrive app page shows a PNG through `LT_Label_1Graphic_Scalable`: write
  it world-readable in `/dev/shm`, `createResourceHandles`, then
  `setValue(0, 'Graphic', file, 'ResourceId')`; a new file name for each new
  image.
- **BMW's `winston-grabber`** captures the composited central screen
  (`--screen center`, 1920x720 @ 60 Hz) and encodes it in hardware
  (`h264_msdk`), to a file, JPEG, or MPEG-TS over UDP (`udp://` pipeline).
  That is the mirror: grab, then ffmpeg cuts out what goes to the cluster.
  It mirrors what the screen shows, so CarPlay must be in front, and BMW's
  pop-ups come along. The CarPlay second screen (above) replaces it.
- Google Maps in CarPlay (dock on the right): the direction card at about
  x 1112-1762, y 4-206; the arrival / time / distance card at about y
  576-716; the clean map between Google's buttons (x < 125) and its cards
  (x > 1110). The map is as zoomed out as Google Maps draws it: zoom in
  Google Maps to see more.
- Two ffmpegs on one UDP port fail: a mirror replacing another must use
  another port (ffmpeg's "Inappropriate ioctl for device" is a failed bind).

## mgu-render in detail *(ref: mgu-store `native/mgu-render/PROTOCOL.md`, `src/`)*

- Socket `/run/mgu-render/render.sock` (0660, group `tm_oap_app`); framing
  `u32 type, u32 len, payload` LE; at most 16 clients. Our client is
  `/var/opt/mgu-render/current/mgu_render_client.js`.
- **The frame file** (`/dev/shm/mgu-video-<name>`): a regular file owned by
  the app's uid, root or `nobody`; at most 4 videos per app; 64-byte header
  words: 0 magic `MGVF`, 1 version 1, 2-3 w h (even, 16..2048), 4 seq, 5
  slot, 6 nslot (1..4), **7 matrix (0 BT.601, 1 BT.709), 8 range (0
  limited, 1 full)**. Frames are **I420 only**, no padding. The writer fills
  slot `(slot+1) % nslot`, then sets `slot`, then `seq + 1`. Budget w×h×3 per
  video: 12 MiB per app, 32 MiB in all. A PLACE with a new size drops the
  videos (send VIDEO again); after a reconnect name the file again.
- **Pacing:** a shown app with a video is polled every 5 ms for a new seq, but
  the redraw is held by the app's **FPS cap** and one frame in flight. Send
  `fps(0)` or at least the stream's rate. `fps.<app>` in
  `/var/opt/mgu-render/mgu-render.local.conf` overrides it.
- **Keep-alive:** at least one message a second; 3 s of silence hides the
  app. Video frames don't count. Root clients are never gated.
- A layer app hides while a camera / video surface (`0x197, 0x198, 0x19d,
  0x19f`) is visible (the reversing camera). idrive7-apps saw `0x198` stay
  "visible" at 0x0 from boot and hide every layer app until a reboot.
- **Draw ops** paint in order, premultiplied alpha: 2 RECT, 4 RRECT, 11
  GLYPHS (client-uploaded glyph atlases), 16 ALPHA, 18 IMAGE `x y w h r id`,
  **19 VIDEO** `x y w h r id` (fitted, centred, corner radius; never inside a
  LAYER). Images: ≤ 1024², premultiplied RGBA, 64 per app, 32 MiB per app.
- **Text over the video (the stop hint):** a frame of `[VIDEO][ALPHA][RRECT
  box][IMAGE hint or GLYPHS][ALPHA 1]`; the renderer redraws the app's last
  frame for every new video frame, so the hint stays on top. Re-send it each
  second (the keep-alive); after N seconds send just the VIDEO op. Simplest:
  rasterise the hint once into an IMAGE. Glyph atlases live in one shared
  2048×4096 texture that is never freed until a restart: keep them small.
- **Embed mode:** an app's picture inside its own HMI page (box
  104,88 1796x632, under the HMI's title bar and pop-ups) through a template
  generated from HmiMain3D and bind-mounted over the widget folder before the
  HMI starts; the first install needs a head-unit restart. The HMI repainted
  embedded surfaces ~20 times a second in the emulator: stay in layer mode
  for streaming until measured.
- **Stats:** while `/run/mgu-render/stats-log` exists, per-app fps and render
  times go to the journal, per-step times to `/run/mgu-render/trace.log`.
  `mgu-render --replay FILE --out F.pam` renders a recorded client stream
  offscreen: pixel-exact off-car tests.
- Winston rebuilds the screen's layer list from each connection's stale copy;
  the HMI resets the layer list on every scene change.
- **Touch CLAIM and our two reboots (a likely cause):** while a claim diverts
  touch, a guard SIGKILLs mgu-render after 1.5 s without its heartbeat
  (`src/touch.c:42, 77-97`); teardown runs `nft -f -` synchronously before
  the next beat (`:58-63, 166`). Killing a renderer with app surfaces up can
  restart the head unit. A slow `nft` (e.g. the 641 duplicate rules per
  chain from the MGU-SSH keeper, [head-unit.md](head-unit.md)) would do it.
  Its touch parser has no iDrive 7 branch (`:182-205`).
- The app area elsewhere: title strip y 0-76, back arrow x 0-84, button bar
  y 596-720 (mgu-store `src/am_elements.js:15-21`); idrive7-apps measured an
  image component at 124,82 1600x520.

## Winston directly (platform `native/winston_out`, 2026-11-07)

Our compositors (chromium-wl, wl-sink) can show their pictures as a Wayland
client of Winston itself, as mgu-render's layer mode does, instead of
through mgu-render's frame file. Measured on the **real Winston binary off
the car** (`tools/winston-bench`: the unit's `winston`, plugins, config and
scene provider in its rootfs container, null outputs), not yet on the car:

- Winston is BMW's **XSWayland 1.2.0.4** (`xswayland-winston`), plugins
  `dlt`, `drm-output`, `notify`, `genivi`; config
  `/etc/winston/compositor.conf` -> `mgu-high/compositor_appl.conf`
  (`initial-visibility = hide`: a new ivi surface shows only once a
  controller makes it visible; `screenshot-group = mgu_wayland`). The scene
  provider (`libivi-scene-settings_hu.so`) makes 26 layers and gives the
  centre screen 21 of them in order.
- Globals: `wl_compositor`, `wl_subcompositor`, `wl_shm` (ARGB8888 and
  XRGB8888 only), `wl_output`, `wl_seat`, `wp_viewporter` (and the old
  `wl_scaler`), `ivi_application`, `ivi_controller` (wayland-ivi-extension
  1.11), **`zwp_linux_dmabuf_v1` v1** with 13 formats (among them XR24 AR24
  XB24 AB24 RG16 NV12 YUYV YU12), private `xs_*`; `wl_drm` through
  `EGL_WL_bind_wayland_display` where its EGL has it (on the car; not on the
  bench's stand-in GPU).
- **Shared memory is taken as it is** (`loading shm buffer (WxH, stride)`), in
  full colour; XRGB8888's alpha byte is ignored. **dmabufs too**: drm-output
  makes a DRM framebuffer of each (for its planes) and its GL renderer
  imports them (`wrapping dmabuf: ... XR24`) on the unit's own i965 with no
  modifier given (`DRM_FORMAT_MOD_INVALID`: the tiling comes from the
  kernel, as for wl_drm). So Chromium's GPU-mode buffers (wl_drm PRIME) can
  go to Winston untouched: no read-back, no I420. So can Wine's GL / Direct3D
  client area (wl-sink), placed with `wo_present_at` where the composed
  picture would have it (the same touch mapping), on a black backdrop
  surface (`surface_id + 1`) where the composed picture is black.
- **NV12 dmabufs too** (a video decoder's pictures: one buffer, Y then
  interleaved UV, two planes): Winston's renderer imports and draws them on
  the unit's i965 (`wrapping dmabuf: ... NV12`, `wo_bench app nv12`), so a
  decoder's output can go to the screen with the YUV conversion on the GPU.
  i965 wants both planes' fds to be one GEM buffer; the bench's stand-in GPU
  first gave each fd its own and the import failed (`EGL_BAD_ALLOC`), fixed in
  the shim (the kernel does it right). Winston then logs `dmabuf N plane 1:
  failed to close gem handle` (both planes share one handle and its scanout
  path closes it twice): harmless. Not yet seen on the car.
- **Release a client's buffer once.** A compositor in front of Winston that
  holds a client's GPU buffer until Winston lets it go must send that
  buffer's `wl_buffer.release` exactly once: a second one, after Wine (Mesa's
  Wayland EGL) had taken the buffer again, made Mesa drop it and Wine stall
  for good, every surface (wl-sink's first pass-through, at a hide, real Wine
  on the bench).
- Placement as mgu-render does it (`src/main.c`, `relist.c`): an ivi surface,
  a controller surface and layer, source / destination rectangles (Winston
  scales; we fit the picture, aspect kept, centred), no input region (touch
  stays with the HMI), the layer onto the centre screen (lowest screen id)
  **through a new connection** each time (Winston applies `add_layer` to the
  list as that connection last saw it; confirmed: the HMI's
  `set_render_order` takes ours off, a fresh connection puts it back with
  the others kept). Winston's socket is `root:mgu_wayland`: a process that
  connects as root and then drops must **keep the socket's group** or the
  next show can't connect (`relist: ... Permission denied`, our layer never
  listed; found by the Browser's end-to-end bench test).
- Frame callbacks come at 60 Hz while our surface shows and **not at all
  while it is hidden** (camera, off): pace clients with a timer of our own.
- A camera surface (0x197) whose client goes stays "visible" without a
  picture: Winston sends `content` 2 (removed), not `destroyed`. Treat 2 as
  gone, or the layer would stay hidden for good.
- Our client's surface and layer go with its connection: a process that
  dies takes its picture off the screen.
- Ids: surface `0x565a0100`, layer `0x565a0000` ("VZ"; mgu-render's are
  `0x4d52....`, the community's `0x4d47....`).
