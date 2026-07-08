// Visual-review setup: render the Floor-1 WELCOME ROOM set piece in the
// engine-backed set-piece lab (?lab=set-piece-lab), full-frame and free of lab
// chrome, then wait for the generated-texture warm + first real-art sync BEFORE
// the screenshot is taken.
//
// ROBUST CAPTURE: the review URL includes `&piece=welcome-room`, so the lab
// boots DIRECTLY into the welcome room (resolveInitialSetPieceId reads the
// param) — a single scene, a single generated-sprite warm, no dropdown-driven
// scene.restart(). The honest readiness gate below (window.__uiProbe.ready())
// only reports true once the CURRENT piece is rendering real art: every TRANSIENT
// prop placeholder Rectangle resolved (a piece's INTENTIONAL queued-art stand-ins
// — custom sprites with no placeholder fallback — may remain) AND every pinned NPC
// texture resident. That defeats the cold-cache race where the harness screenshots
// the grey-placeholder / villager-fallback state (~199KB PNG) instead of the real
// room (~376-460KB PNG).
//
// This surface declares NO window.__visualReview* clip: the room is a single
// Phaser <canvas> with no measurable DOM element bounds, so the review correctly
// runs screenshot-only (the agent logs the absent geometry harness as a loud,
// non-gating warning).
//
// The display-list sanity below is intentionally TYPE-based (count Rectangles /
// Images by GameObject type), never keyed on specific prop texture names, so it
// stays decoupled from concurrent set-piece prop-key / sizing changes — the
// honest ready() gate is the real guarantee; this is defense-in-depth.
(async () => {
  const TARGET = 'welcome-room';
  const DEADLINE_MS = 45000;

  if (document.fonts?.ready) {
    await document.fonts.ready;
  }

  // 1. Hide outer lab chrome for a clean, game-like capture.
  const header = document.getElementById('app-header');
  if (header) header.style.display = 'none';
  const controlsEl = document.getElementById('lab-controls');

  // 2. Grab the lab GUI BEFORE hiding the controls host (the GUI object lives on
  //    the element regardless of visibility). Used only for the stale-bundle
  //    fallback below; absence is non-fatal (direct-boot is the normal path).
  const gui = controlsEl && controlsEl.__labGui;
  const pieceCtrl =
    gui &&
    (typeof gui.controllersRecursive === 'function'
      ? gui.controllersRecursive()
      : gui.controllers
    ).find((c) => c.property === 'setPieceId');

  if (controlsEl) controlsEl.style.display = 'none';

  // 3. Expand the canvas host to the full viewport on a black backdrop. The lab
  //    uses Phaser.Scale.RESIZE with a ResizeObserver on the game host, so the
  //    room re-fits to whatever size we give it.
  const host = document.getElementById('lab-canvas');
  if (host) {
    host.style.position = 'fixed';
    host.style.left = '0';
    host.style.top = '0';
    host.style.width = '100vw';
    host.style.height = '100vh';
    host.style.zIndex = '9999';
    host.style.background = '#000';

    // 4. Hide the info/debug pane (last child of the lab root flex column) so the
    //    rendered room — not the metadata pane — fills the frame.
    const root = host.firstElementChild;
    if (root && root.lastElementChild) {
      root.lastElementChild.style.display = 'none';
    }
  }

  // 5. Let the layout settle, then force a resize so the RESIZE-mode canvas picks
  //    up the new full-viewport host size.
  window.dispatchEvent(new Event('resize'));
  await new Promise((r) => setTimeout(r, 250));

  const readyProbe = () => {
    const probe = window.__uiProbe;
    return !!probe && typeof probe.ready === 'function' && probe.ready() === true;
  };

  // 5b. DEFENSIVE FALLBACK ONLY: if the URL `?piece=welcome-room` param was not
  //     honored (a stale lab bundle predating resolveInitialSetPieceId), drive the
  //     dropdown to the welcome room. On the normal path the lab already booted
  //     into TARGET (getValue() === TARGET) and we do NOT restart. A restart is
  //     safe here — the lab re-warms on every create() (no global warm latch) and
  //     the Phaser texture cache persists across restarts, so the re-entered scene
  //     resolves against already-resident textures — but we still gate the capture
  //     on the honest ready() poll below regardless of which path we took.
  if (pieceCtrl && pieceCtrl.getValue() !== TARGET) {
    pieceCtrl.setValue(TARGET);
    // Give the restarted scene a beat to re-enter create() and reset readiness.
    await new Promise((r) => setTimeout(r, 250));
  }

  // 6. Confirm the welcome-room scene is actually rendering real art before the
  //    screenshot: the honest readiness probe is true AND the live display list
  //    shows at least one real-art Image. ready() alone is the authoritative,
  //    complete guarantee (imageCount > 0, every TRANSIENT placeholder Rectangle
  //    resolved down to the piece's intentional queued-art stand-ins, all pinned
  //    NPC keys resident); the display-list re-check is redundant insurance against
  //    a probe that never installed. It deliberately checks only `at least one
  //    Image` and must NOT re-require zero Rectangles — welcome-room's honest
  //    custom-placeholder props (Kenney art retired to the art queue) render as
  //    permanent Rectangles, so a zero-rect re-check would spin to the deadline
  //    even though ready() is already honestly true.
  const allLoaded = () => {
    if (!readyProbe()) return false;
    const scene = window.__setPieceScene;
    const kids = (scene && scene.children && scene.children.list) || [];
    let realImages = 0;
    for (const o of kids) {
      if (o.type === 'Image') {
        realImages += 1;
      }
    }
    return realImages > 0;
  };

  const deadline = Date.now() + DEADLINE_MS;
  while (!allLoaded() && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 200));
  }

  // Settle: let the static diorama's per-frame re-sync upgrade any final
  // placeholder to its now-resident real texture over several frames.
  await new Promise((r) => setTimeout(r, 1000));

  window.__visualReviewClip = null;
  window.__visualReviewHoverPoint = null;
})();
