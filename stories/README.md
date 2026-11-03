# Stories

Upcoming work on Cast to cluster, one story a file. Each says why, what we
already know, the work, how we know it is done, and what it depends on.
Background for all of them: [`../Learnings.md`](../Learnings.md).

| # | Story | Size | Depends on |
|---|---|---|---|
| 01 | [No take-over on the cluster (BC crash)](01-no-takeover-on-cluster.md) | S | — |
| 02 | [Logs that survive a restart](02-persistent-logs.md) | S | — |
| 03 | [Does CarPlay keep sending video in the background?](03-carplay-background-test.md) | S (test) | — |
| 04 | [Auto mode: mirror only while Google Maps navigates](04-auto-navigation-detection.md) | M | 02 helps |
| 05 | [The volume pop-up and other HMI overlays](05-hmi-overlays.md) | S–M | 04 |
| 06 | [Direct CarPlay feed (no screen grab)](06-direct-carplay-feed.md) | L | 03 says yes |
| 07 | [The cluster's own direction list over the mirror](07-cluster-direction-list.md) | S | 01 |
| 08 | [Control socket hardening](08-control-socket-hardening.md) | S | — |
| 09 | [Sharper picture: the grabber's encoder](09-grabber-quality.md) | S | — |
| 10 | [Repository housekeeping](10-repo-housekeeping.md) | S | you |

Suggested order: 01 and 02 first (safety and diagnosis, one release,
0.2.2), then 03 (a ten-minute test that decides 06), then 04 and 05.

Release rule: every change to what a component ships needs a version bump
(`node release/release.js bump <id> <x.y.z>`); publish with the Release
workflow (Actions > Release, the component ids).
