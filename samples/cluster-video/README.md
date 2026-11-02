# cluster-video sample

The bench tests that led to [vizualyse-cast](../../native/vizualyse-cast):
raw frames and sound from files, decoded beforehand on a PC.

- `play.js`: raw I420 frames from a file as a cluster-render video layer on
  the cluster map (`--target map`) or the HUD (`--target hud`, in the band
  between its clipped top and its speed).
- `pcm_play.py` (mgu-python): raw S16LE 48 kHz stereo into SmartXbar's
  `CarPlayMain_CF_48_STEREO` source, through libasound with ctypes.

```sh
ffmpeg -ss 150 -t 30 -i input.mkv -an -sn -vf "scale=480:270,fps=15,format=yuv420p" -f rawvideo clip.yuv
ffmpeg -ss 150 -t 30 -i input.mkv -vn -ac 2 -ar 48000 -f s16le clip.pcm
# on the unit, beside cluster_render_client.js:
node play.js --file clip.yuv --target map & python3 pcm_play.py --file clip.pcm --gain 0.6
```

A tech demo: video on the cluster or the HUD is for a parked car.
