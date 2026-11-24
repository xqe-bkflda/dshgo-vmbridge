# dshgo-vmbridge

**DSH Go plugin** · Let an AI agent drive an **AndVM** Android emulator on your phone: read the screen, tap buttons, type, run root shell commands, install APKs, take screenshots.

> A local plugin for the [DSH Go](https://github.com/xqe-bkflda) phone app — not a Cordis bundle, not a desktop plugin.

Your phone has no root, so this uses **AndVM** (an AVF-based, rootless Android VM) to boot a Magisk-rooted Android 12 instance. The plugin runs inside DSH's proot Ubuntu and drives that VM over `adb`.

```
[AI model]
   ↓ calls vm_* tools
[local-vmbridge plugin]   ← runs in DSH Go's proot Ubuntu
   ↓ adb (127.0.0.1:5037 fork-server)
[127.0.0.1:<AndVM debug port>]   ← changes on every AndVM restart
   ↓
[Android 12 VM inside AndVM]   ← Magisk root
   ├── Shot.apk  (accessibility-based screenshot, must be installed)
   └── whatever app the agent is driving
```

## Requirements (both are mandatory)

### 1. AndVM

- Install [AndVM](https://andvm.cn) (package `com.lerist.andvm`), create and boot a VM
- Inside the VM: **Settings → Debug → enable ADB**
- The debug page shows a **local address `127.0.0.1:NNNNN`** — note the port, it **changes on every restart**

> The plugin only drives the VM; it does not provide one.

### 2. Shot.apk (inside the VM)

**Why it's needed**: the AndVM image has no `gralloc mapper` registered (`/vendor/etc/vintf/manifest.xml` is an empty read-only mount), so `screencap` aborts with `gralloc-mapper is missing` and produces 0-byte files — under both shell and root. `/dev/graphics/` and `/dev/fb*` don't exist, and swapping libc++ via `LD_PRELOAD` is rejected by the linker namespace.

The only working path is in-app `AccessibilityService.takeScreenshot()` (API 30+), which bypasses gralloc entirely. `Shot.apk` is a 17 KB helper that does exactly that.

**Install (either way)**:

```bash
# Option A — let the plugin do it (recommended)
vm_shot_setup(reinstall=true)
# pushes Shot.apk → pm install -r -g → enables accessibility → self-tests a capture

# Option B — manual
adb -s 127.0.0.1:<port> install -r -g Shot.apk
adb -s 127.0.0.1:<port> shell "su -c 'settings put secure enabled_accessibility_services com.dsh.shot/com.dsh.shot.ShotService; settings put secure accessibility_enabled 1'"
```

Then confirm **Settings → Accessibility → Shot** shows *enabled*.

## Install the plugin

```bash
cp -r dshgo-vmbridge "$DSH_HOME/dsh-go/plugins/local-vmbridge"
dsh plugin --profile web add "$DSH_HOME/dsh-go/plugins/local-vmbridge"
```

Restart the engine from the app: **sidebar → Engine → Restart engine**.

## Tools

| Tool | What it does |
|---|---|
| `vm_status` | adb connection state, guest Android version, su root availability |
| `vm_connect_adb` | point the bridge at an AndVM port (or auto-scan) |
| `vm_screen` | read the current UI as a labelled element tree |
| `vm_screenshot` | PNG screenshot of the whole screen |
| `vm_click` | tap by coordinates or by element id |
| `vm_text` | type into the focused field |
| `vm_swipe` | swipe / scroll |
| `vm_shell` | run a shell command (with `su` available) |
| `vm_install_apk` | push + `pm install -r -g -d` |
| `vm_start` / `vm_apps` | launch and list apps |
| `vm_uninstall_apk` | uninstall (user 0 for system apps) |
| `vm_shot_setup` | install / repair the Shot helper |

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `gralloc-mapper is missing` | `screencap` can't work in AndVM | install Shot.apk, use `vm_screenshot` |
| `Connection reset by peer` | AndVM restarted, port changed | `vm_connect_adb` with the new port, or `scan=true` |
| `device unauthorized` | ADB prompt not accepted | open the VM screen and accept |
| `adb: cannot connect` | fork-server not running | `vm_connect_adb` then check `vm_status` |

## License

MIT — see [LICENSE](LICENSE).
