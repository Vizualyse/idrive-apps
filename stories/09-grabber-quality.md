# 09 · Sharper picture: the grabber's encoder

## Why

The mirror is limited by cluster-render's ~5500 KB/s upload (now 1052x410 at
8 fps) and by the hardware encoder's compression, whose settings are unknown.

## Work

- Find `h264_msdk`'s parameters in `/usr/lib/winston-grabber/h264_msdk.so`
  (strings next to `wg_param_get_int`: gop, timeout, likely bitrate, qp,
  profile) and try a higher bitrate or a fixed QP.
- Compare the same scene at each setting (a frame from the UDP stream,
  decoded on the PC).
- Option: `rgb` instead of h264 (`rgb.so`, uncompressed): no compression at
  all, but far more data; only if a raw path to ffmpeg exists.

## Done when

- A setting that is visibly sharper on the cluster at the same CPU, or a
  note in `Learnings.md` that the default is as good as it gets.
