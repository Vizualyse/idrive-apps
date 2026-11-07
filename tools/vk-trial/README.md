# vk-trial: one Vulkan try on the head unit, ended by any restart

A gate for trying a Vulkan driver (Mesa 19.0.6's ANV, the candidate in
[knowledge/browser.md](../../knowledge/browser.md), "Vulkan on this kernel")
on the unit without being able to loop it the way 0.1.1 did: Mesa 22.3's ANV
hung the kernel, the HMI blocked on the DRM lock, the unit restarted, and
the tool started the driver again on every boot.

Never shipped through the Store; installed by hand, run by hand, over SSH.

## The guarantees

| | how | tested off the car |
|---|---|---|
| **Armed by hand only, one start** | `vk-trial arm STAGE` writes `/run/vk-trial/armed`; `vk-trial run` uses it up | a second `run` does nothing; two `run`s at once start one child |
| **A restart always disarms** | the arming lives only in `/run`; `arm` refuses unless `/run` is tmpfs; `run` refuses an arming from another boot id | a "restart" (new container: fresh tmpfs, new boot id, same `/var/opt`) finds it gone |
| **Disarm before anything else** | `run`'s first syscall on a file is `rename()` of the arm file; if that fails it prints one line and exits. The gate is static: it never loads a library, let alone a GPU driver; only its child does | `strace`: nothing between glibc's own start and the rename; unarmed: the rename, one write, exit. `/proc/<gate>/maps` has no `.so` |
| **The driver only reachable during the try** | its ICD file is written into `/run` after the disarm and removed after the child; only the child's environment names it; `arm` refuses while any ICD or implicit layer sits where the system's loader looks | the ICD exists for the child, gone after; a system ICD blocks arming |
| **A witness that survives the restart** | `state/trial` (fsynced) before the child starts, removed after it ended; found from another boot = the try hung. Then `arm` wants `--again` | a container killed mid-try: the next boot reports `hung`, `arm` refuses without `--again` |
| **Where it stopped** | `vk_crumbs.so` writes every DRM ioctl to `crumbs.log` (O_DSYNC) before it enters the kernel and its return after: the last `>` without its `<` is the call that never came back | the crumbs of every stage below |
| **Not the display** | the child, still root, makes its own mount namespace, private, and binds `/dev/null` over every `/dev/dri/card*` (Winston's): kernel-enforced, whatever it runs and however it opens them. The gate checks the system still sees the real nodes before the child goes on (any that changed are unmounted, the child killed); if the namespace can't be made, the child never starts. `vk_crumbs.so` also refuses `card*` by path, and the probe never asks for `VK_KHR_display` | in the child `card0` is `/dev/null` by absolute path, relative path and the by-path symlink, the render node unchanged; the system sees the real `card0` during and after, with no mount of it; without `SYS_ADMIN` the child exits 110 before exec |
| **Least privilege** | the child runs as uid 12990 (not an uplink uid: no network), group `video` (44) only, can't write the gate's state, no core dumps (`RLIMIT_CORE` 1: the unit's crash handler can restart it for an unlisted program's core) | `id` and `/proc/self/limits` in the child; state not writable |
| **A dead gate in the same boot** | a marker whose gate is gone: refused while its child still runs without it (probably stuck in the kernel: restart the unit), closed as `died` once both are gone (killed, or the software restarted without a reboot) | gate killed: `arm` refuses while the child lives, then closes the try as `died` and arms; both killed: closed at the next start |
| **Bounded** | no new crumb for 8 s: `sysrq w` (blocked tasks with stacks into the kernel log, the holder of the DRM lock last time); the kernel log is copied into `kmsg.log` and fsynced every second; at the timeout (30 s by default) the child is killed | a stalled child: the dump asked for once at 8 s, killed at its timeout, `result=timeout`; fake i915 lines written into `/dev/kmsg` during a try land in `kmsg.log` (none from before it) and make the result `gpu-hang` with `kernel_blocked_tasks=yes`, though the child exited 0. Only the sysrq write itself succeeding is unseen (read-only in Docker) |
| **Never from systemd** | run by hand over SSH; the gate ignores SIGHUP and goes on if the session drops | (recmgr restarts the unit when a non-whitelisted unit exits: [knowledge/head-unit.md](../../knowledge/head-unit.md)) |

Not tested off the car: a child stuck in the kernel (unkillable, `result=stuck`,
the marker kept so the restart reports `hung`; the "child without its gate"
refusal it relies on is tested), the leak check's undo (nothing leaks in
Docker), a real power cut, and of course the kernel and the GPU themselves.
`stuck`, `hung` and `gpu-hang` all make the next `arm` want `--again`.

**Only over SSH:** `arm` and `run` (right after the disarm) want something
listening on TCP 22 and their own session's connection (`SSH_CONNECTION`)
established, else nothing happens; `status` shows it. On the unit that is
systemd's `sshd.socket`, and a login doesn't touch the GPU, so a blank
screen still leaves a way in.

**Dry run on the car** (2026-11-07): `sh test/make_dryrun.sh` builds
`build/vk-trial-dryrun.tgz` (the real gate and crumbs, shell-script children,
a 0-byte placeholder for the driver). Every safety above held on the unit
([knowledge/browser.md](../../knowledge/browser.md)).

## Stages

Each try goes one stage further than the last one that came back:

| stage | what runs | first touches |
|---|---|---|
| `instance` | the loader loads ANV, `vkCreateInstance` | nothing of the GPU |
| `enumerate` | `vkEnumeratePhysicalDevices` | opens the render node: GETPARAMs, GTT size, a syncobj create / wait / destroy, a context priority set |
| `device` | `vkCreateDevice` | **the first GPU work**: a context, and two small batches submitted and waited for **without a timeout** (ANV's device init) |
| `compute` | a compute shader on 1024 numbers, waited for 5 s, checked on the CPU | a real dispatch (8 buffers) |
| `command` | `arm command -- PROGRAM ARG...`: anything (vkcube, a game through Proton + DXVK) | whatever it does |

## Use

Off the car:

```sh
sh tools/vk-trial/build.sh             # build/vk-trial.tgz (needs gpu-bench's image; ~2 min first time)
sh tools/vk-trial/test/gate_test.sh    # the gate's guarantees, in the unit's rootfs
sh tools/vk-trial/test/anv_test.sh     # ANV through the gate on gpu-bench's stub HD 505, every stage
```

On the car, **only with the owner's go-ahead for each step** (anything that
starts or stops something on the unit is asked first). Read-only first:

```sh
cat /sys/module/i915/parameters/enable_ppgtt /proc/sys/kernel/hung_task_timeout_secs
ls /etc/vulkan /usr/share/vulkan /usr/local/share/vulkan 2>&1   # no ICDs expected
```

Install (a folder of files, no service):

```sh
scp tools/vk-trial/build/vk-trial.tgz root@169.254.224.142:/tmp/
mkdir -p /var/opt/vk-trial && tar xzf /tmp/vk-trial.tgz -C /var/opt/vk-trial && chmod 755 /var/opt/vk-trial
/var/opt/vk-trial/bin/vk-trial status
```

One try:

```sh
/var/opt/vk-trial/bin/vk-trial arm instance     # then enumerate, device, compute: one per try
/var/opt/vk-trial/bin/vk-trial run              # prints the result; exit 0 = ok
cat $(cat /var/opt/vk-trial/state/last)/{result,out.log,crumbs.log}
dmesg | tail -30                                # i915 lines, GPU HANG
```

If the unit restarts: nothing to do. Afterwards `vk-trial status` says the
try hung, and `state/log/<time>-<boot>-<stage>/` has the crumbs (the call
that never returned) and `kmsg.log` (with luck the `sysrq w` dump).

Ways back over SSH, if ever needed: `vk-trial disarm`; `rm /run/vk-trial/icd.json`;
`rm -r /var/opt/vk-trial` removes it all.

## Files

| | |
|---|---|
| `src/vk-trial.c` | the gate (static) |
| `src/vkprobe.c` | the staged probe (glibc 2.27, the unit's loader) |
| `src/vk_crumbs.c` | breadcrumbs and the display-node guard, preloaded into the child |
| `image/Dockerfile` | Ubuntu 18.04 (glibc 2.27): ANV from Mesa 19.0.6 (source from gpu-bench's image), the Khronos loader 1.1.70, strace; the shader through glslang (Debian) |
| `test/kernel414.c` | bench only: answers like the unit's IOTG 4.14 kernel where the shim would say yes (no param after 49, no context param after 6, ioctl 0x39 flagged) |
| `test/gate_test.sh`, `test/fake_probe.sh` | the gate's guarantees |
| `test/anv_test.sh` | ANV on the stub, every stage, and its ioctls next to the unit's i965 |

On the unit: `/var/opt/vk-trial/{bin,lib}` (the package), `state/` (root,
0700: `trial` the marker, `last`, `log/<time>-<boot>-<stage>/` with
`gate.log`, `out.log`, `crumbs.log`, `kmsg.log`, `result`), `/run/vk-trial/`
(the arming, the ICD during a try).
