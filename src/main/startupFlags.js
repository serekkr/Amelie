/**
 * Every Chromium switch Amelie sets BEFORE app 'ready', decided in one place.
 *
 * Pre-ready is the only moment these take effect at all, so they used to be a
 * run of bare `appendSwitch` calls at the top of main.js — and three of them
 * were workarounds for ONE machine that every install then paid for. That is
 * the rule this function exists to make visible and to keep: a switch that
 * fixes one compositor, one driver or one box is OPT-IN; only a switch that is
 * right everywhere is unconditional.
 *
 * `cfg` is settings.json as it is on disk (read synchronously, may be {}).
 * Returns the switches to append — [name] or [name, value] — plus whether to
 * call app.disableHardwareAcceleration(), which is not a switch.
 */
function startupFlags(cfg) {
  const c = cfg || {};
  const switches = [];

  // ── Always ─────────────────────────────────────────────────────────────────
  // One GPU process inside the browser process. Not a workaround: it also stops
  // Chromium putting a second entry in the taskbar.
  switches.push(['in-process-gpu']);

  // No OS keyring / wallet on startup. Two separate mechanisms would pop a
  // KWallet password dialog on KDE:
  //   1) the legacy os_crypt password store → force 'basic' (plaintext key, no
  //      kwallet)
  //   2) Chromium's os_crypt_async SecretPortalKeyProvider (default-ON since
  //      ~Cr130), which asks xdg-desktop-portal for a secret →
  //      xdg-desktop-portal-kde opens the wallet.
  // Baked into the code, not the launcher: repeating it on the command line
  // changed nothing except putting "--password-store=basic" in `ps aux`, where
  // it reads as "the app keeps a password in the clear". Measured with it
  // removed from the launcher: the backend is still basic_text.
  // Amelie no longer stores the vault passphrase, so safeStorage covers only the
  // SMB/WebDAV credential blob in settings.json — fine on a plaintext key.
  switches.push(['password-store', 'basic']);
  switches.push(['disable-features', 'SecretPortalKeyProvider']);

  // ── Opt-in: workarounds, not defaults ──────────────────────────────────────
  // GPU rasterization always stays on; COMPOSITING can be moved to software.
  // On some compositors (Wayland + in-process GPU, the Intel Arc box this was
  // written on) hardware compositing leaves stale tiles — "ghost" rectangles in
  // the editor where code-block boxes once were — that no repaint can clear:
  // reflow, invalidate, an opacity nudge, even a full DOM rebuild.
  //
  // It was unconditional, on the grounds that the cost is negligible for a text
  // app. That was only ever true of the text. A drawing is not text: every frame
  // of a stroke is a full software recomposite of the canvas. Measured on a
  // drawing with 12 shapes under a 5-second freehand stroke:
  //
  //     software compositing + low-memory    34 fps    119% of a core
  //     GPU compositing + low-memory         60 fps    106%
  //     GPU compositing, no low-memory       60 fps     60%
  //
  // Half the frame rate for twice the CPU — which is what "the draw goes in slow
  // motion" was, reported on an Ubuntu 26 LTS machine that never had the
  // ghosting bug in the first place (2026-09-10).
  // Still honoured, but there is no longer a toggle for it: the Settings row was
  // removed on 2026-09-20 because next to "GPU rendering" it read as the same switch
  // listed twice. Set it in settings.json by hand if a compositor needs it.
  if (c.softwareCompositing) switches.push(['disable-gpu-compositing']);

  // Chromium's low-end-device-mode plus a 512 MB renderer heap. Forced on for
  // everyone from v1.0.643; it cuts raster threads and tile budgets, which a
  // canvas being drawn on feels immediately — the ~46 points of CPU between the
  // last two rows above.
  // No toggle for this either, since 2026-09-20 — same reasoning as the compositing
  // one above, and the same escape hatch: write it into settings.json by hand.
  if (c.lowMemory) {
    switches.push(['enable-low-end-device-mode']);
    switches.push(['js-flags', '--max-old-space-size=512']);
  }

  // Software RENDERING, the heaviest of the three. NOTE: it does NOT save system
  // RAM — with in-process-gpu there is no separate GPU process to drop.
  const disableHardwareAcceleration = !!c.disableGpu;
  if (disableHardwareAcceleration) switches.push(['disable-gpu']);

  return { switches, disableHardwareAcceleration };
}

module.exports = { startupFlags };
