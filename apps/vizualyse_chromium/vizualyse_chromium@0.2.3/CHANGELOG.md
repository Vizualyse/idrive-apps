# Changelog

## 0.2.3

- **Make room** button: while the browser is on, the Moonlight and Cast
  tools are paused to leave their memory to it (Cast's cluster map too), and
  start again when it goes off. The button names what is paused.
- Requires vizualyse-chromium 0.2.4 (which also trims Chromium's own
  memory, frees memory near the cap and offers a 3 GB cap).

## 0.2.2

- **Resolution** button: full, 3/4 or 1/2. The browser draws fewer pixels
  (faster on the car's processor, lighter on memory, a little blurrier) and
  the picture is scaled up to the screen; the page keeps its layout.
- Requires vizualyse-chromium 0.2.3.

## 0.2.1

- The GPU row says `WebGPU: GLES compat` when the GPU mode runs WebGPU in
  compatibility mode on the car's graphics driver.
- When a page needs more memory than the browser's cap, the status line
  says so for 2 minutes (the cap is set on the phone page).
- Requires vizualyse-chromium 0.2.2.

## 0.2.0

- **GPU mode** button (experimental): the tool restarts the browser with
  WebGL on the car's own graphics driver instead of the CPU, and turns it
  off again by itself if that fails. Never kept: every start of the tool is
  on the CPU.
- The GPU row says what WebGL got in one line (`CPU (SwiftShader)` or
  `GLES 3.2, Intel HD Graphics 505 (APL 3)`), or what became of the GPU mode.
- Requires vizualyse-chromium 0.2.0.

## 0.1.1

- Touches on the browser no longer press the page under it: Show opens an
  empty screen page (nothing to press) and puts the browser up once it is
  visible; BACK returns to the main page and hides the browser. While the
  browser is up, every button of the main page is disabled as well.
- Requires vizualyse-chromium 0.1.1.

## 0.1.0

- The page: status, the phone link as a QR code and as text, Show on the
  screen, Browser on / off, Home page, Reload, Back, the page shown (title
  and address) and what the GPU offers (WebGPU, WebGL 2, JSPI).
- Leaving the page (the back arrow, another app) or an HMI pop-up over it
  hides the browser.
- Only while parked: the car's speed (Vehicle2) goes to the tool every
  second.
- Requires vizualyse-chromium 0.1.0.
