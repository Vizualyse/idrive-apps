# Changelog

## 0.1.2

- No change to the page: its shared files (the QR code, the car's speed) now
  come from the platform's modules, byte for byte as before.

## 0.1.1

- A game on a USB stick that isn't plugged in says so on its Play button
  (`Play: <game> (USB stick not plugged in)`) and can't be pressed (tool
  0.1.1 installs games on USB sticks).

## 0.1.0

- The page: status, the phone link as a QR code and as text (sign in to
  Steam and install games there), a Play button for each installed game (up
  to four), Show on the screen, Stop the game, Picture (the size the game
  draws at), Steam on / off, what is playing and what is downloading.
- Play from the car shows the game once it draws (through an empty screen
  page, so touches on the game press nothing of the HMI).
- Leaving the page (the back arrow, another app) or an HMI pop-up over it
  hides the game; it keeps running until Stop.
- Only while parked: the car's speed (Vehicle2) goes to the tool every
  second.
- Requires vizualyse-steam 0.1.0.
