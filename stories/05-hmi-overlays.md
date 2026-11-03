# 05 · The volume pop-up and other HMI overlays

## Why

Changing the volume puts BMW's volume pop-up on the central screen, and the
mirror copies it onto the cluster or the HUD. Other HMI pop-ups (calls,
warnings, notifications) will do the same.

## Work

- A still of the volume pop-up (story 03's recorder takes one) to see where
  it sits and what it looks like.
- With the detector of story 04: when the pop-up's patch matches, or the
  navigation patches stop matching for a moment, **hold the last good frame**
  instead of sending new ones, until it is gone (hold at most ~5 s, then
  stop as auto mode would).
- If the pop-up never covers the regions a layout uses, only the detector
  needs to ignore it.

## Done when

- Changing the volume with a mirror up: the cluster or HUD keeps the last
  map frame, no pop-up, and carries on after it closes.

## Note

A direct CarPlay feed (story 06) removes this problem entirely: HMI pop-ups
are not in CarPlay's own picture.
