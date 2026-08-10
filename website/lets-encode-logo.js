/*
 * lets-encode-logo.js
 * Drives the "Let's Encode" animated logo.
 *
 * Requirements:
 *   - The logo SVG must be INLINED into the page (not loaded via <img>),
 *     so its internal CSS animations can be triggered. The root <svg> has id="svg1".
 *   - This script finds that <svg>, plays the hand sequence once, then
 *     replays it automatically at a random interval between 7 and 12 seconds.
 *   - Respects prefers-reduced-motion: if set, the logo stays static.
 *
 * Interactivity:
 *   - Three hover zones, one per hand (only the hands are hot — not the
 *     apostrophe or note). Each hand still drags its companion element along:
 *       orange hand -> orange hand + apostrophe
 *       blue hand   -> blue hand + note
 *       green hand  -> green hand
 *   - While the cursor is over a hand, that zone's transform eases to the
 *     "peak" of its animation (the bottom of the boop, etc.) and holds there;
 *     when the cursor leaves, it eases back (the return leg). This is driven by
 *     CSS transitions on the .hover-* classes (see the SVG's inline styles).
 *   - The automatic-random-animation timer is paused while a zone is hovered
 *     and resumes once the cursor is off all zones.
 *
 * Usage:
 *   <script src="lets-encode-logo.js" defer></script>
 *   (or import and call initLetsEncodeLogo() yourself after the SVG is in the DOM)
 */
(function () {
  "use strict";

  // Full sequence length in ms: green hand starts at 0.525s and runs 0.45s.
  var SEQUENCE_MS = 975;
  var MIN_GAP_MS = 7000;
  var MAX_GAP_MS = 12000;

  // Individual hover zones: each hand plus the glyph it tweaks. Hovering any of
  // these replays that hand's own gesture once (a full loop, not a hold).
  var ZONES = {
    orange: ["orange-hand", "apostrophe"],
    blue:   ["blue-hand", "note"],
    green:  ["green-hand"]
  };
  var ZONE_MS = 650; // a touch longer than the longest single gesture (~0.55s)

  function initLetsEncodeLogo(svg) {
    svg = svg || document.getElementById("svg1");
    if (!svg) return;

    var reduce = window.matchMedia("(prefers-reduced-motion: reduce)");
    if (reduce.matches) return; // honour the user's motion preference

    var timer = null;
    var comboPlaying = false;
    var zoneBusy = {};

    function pauseAuto() {
      if (timer) { window.clearTimeout(timer); timer = null; }
    }

    function scheduleNext() {
      pauseAuto();
      var gap = MIN_GAP_MS + Math.random() * (MAX_GAP_MS - MIN_GAP_MS);
      timer = window.setTimeout(playCombo, SEQUENCE_MS + gap);
    }

    // Automated combo: the full staggered orange -> blue -> green sequence.
    // .play is removed once the sequence ends so it can't keep an identical
    // animation applied to the hands and shadow the per-hand hover replays.
    function playCombo() {
      svg.classList.remove("play");
      void svg.getBoundingClientRect(); // reflow so the animation restarts cleanly
      svg.classList.add("play");
      comboPlaying = true;
      window.setTimeout(function () {
        svg.classList.remove("play");
        comboPlaying = false;
      }, SEQUENCE_MS + 50);
      scheduleNext();
    }

    // One hand's own gesture, played once when its zone is hovered.
    function playZone(zone) {
      if (zoneBusy[zone]) return; // don't restart mid-gesture
      var cls = "play-" + zone;
      svg.classList.remove(cls);
      void svg.getBoundingClientRect();
      svg.classList.add(cls);
      zoneBusy[zone] = true;
      window.setTimeout(function () {
        svg.classList.remove(cls);
        zoneBusy[zone] = false;
      }, ZONE_MS);
    }

    // Desktop: hovering a single hand (mouse or pen) replays just that hand's
    // gesture. We discriminate by pointerType so a finger tap never triggers an
    // individual hand — on touch the whole logo plays the combo instead (below).
    Object.keys(ZONES).forEach(function (zone) {
      ZONES[zone].forEach(function (id) {
        var el = svg.querySelector("#" + id);
        if (el) el.addEventListener("pointerenter", function (e) {
          if (e.pointerType === "touch") return;
          playZone(zone);
        });
      });
    });

    // Mobile/touch: a tap anywhere on the logo plays the full staggered
    // orange -> blue -> green sequence, rather than any one hand.
    svg.addEventListener("touchstart", function () { playCombo(); }, { passive: true });

    // On touch, a tap leaves :hover "stuck" on the brand, so the navbar logo
    // stays colourful indefinitely. Track whether the current brand interaction
    // is touch (and clear the settle-to-mono override on every fresh press so
    // hover/tap can re-colour it).
    // We only ever set brandTouched *true* — never reset it from a pointer
    // event. Browsers fire a compatibility mouse-type pointerdown after a touch
    // tap, and deriving the flag from pointerType let that stray event flip it
    // back to false, so the settle-to-mono step below never ran. touchstart is
    // the reliable touch signal (it never fires for a real mouse).
    var brand = document.querySelector(".brand");
    var brandTouched = false;
    if (brand) {
      brand.addEventListener("pointerdown", function (e) {
        brand.classList.remove("is-mono"); // fresh press: allow re-colour
        if (e.pointerType === "touch") brandTouched = true;
      });
      brand.addEventListener("touchstart", function () {
        brand.classList.remove("is-mono");
        brandTouched = true;
      }, { passive: true });
    }

    // "Back to top" links (navbar brand, footer wordmark) replay the full combo
    // once the scroll-to-top has settled. The target is the document top, so we
    // just wait for scrollY to reach 0 — covers smooth scrolling, instant jumps,
    // and the already-at-top case — then play. Bound here (after the reduced-
    // motion early-return) so it stays silent when motion is reduced.
    Array.prototype.forEach.call(document.querySelectorAll('a[href="#top"]'), function (link) {
      link.addEventListener("click", function () {
        var tries = 0;
        var iv = window.setInterval(function () {
          if (window.scrollY < 1) {
            window.clearInterval(iv);
            // Touch only: settle the navbar logo back to monochrome as soon as
            // the scroll-to-top completes (the class outranks the stuck :hover).
            // Skipped on mouse/pen, where :hover correctly keeps colour while
            // hovering. Done before playing so the hero gets the colour, not it.
            if (brandTouched && link.closest(".brand")) {
              brand.classList.add("is-mono");
            }
            playCombo();
          } else if (++tries > 60) { window.clearInterval(iv); }
        }, 40);
      });
    });

    // Pause the auto-combo while the tab is hidden; resume when visible again.
    document.addEventListener("visibilitychange", function () {
      if (document.hidden) { pauseAuto(); }
      else if (!comboPlaying) { playCombo(); }
    });

    playCombo();
  }

  // Expose for manual init, and auto-run on DOM ready for the default #svg1.
  window.initLetsEncodeLogo = initLetsEncodeLogo;

  // Guard so a logo-init error can never abort the script before the
  // header-hands initialiser (below) runs.
  function safeInitLogo() {
    try { initLetsEncodeLogo(); } catch (e) { /* logo stays static; hands still load */ }
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", safeInitLogo);
  } else {
    safeInitLogo();
  }
})();

/* ---------------------------------------------------------------------------
 * Header hands
 *
 * Each section <h2> carries a small cartoon hand that "tweaks" a glyph in the
 * heading (see styles.css — the .gx / .hand / .hpic mechanic). This driver
 * plays each hand's animation once, then replays at a random 6–10s interval,
 * staggered so they don't move in unison. Hovering anywhere on a heading
 * replays its hand immediately and suspends that hand's auto-timer so the two
 * never collide; leaving resumes the loop. Honours prefers-reduced-motion.
 * ------------------------------------------------------------------------- */
(function () {
  "use strict";

  function initHeaderHands() {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    Array.prototype.forEach.call(document.querySelectorAll(".gx"), function (el, idx) {
      var timer = null;
      function play() {
        el.classList.remove("go");
        void el.offsetWidth; // force reflow so the animation restarts cleanly
        el.classList.add("go");
      }
      function schedule() {
        timer = window.setTimeout(function () { play(); schedule(); }, 6000 + Math.random() * 4000);
      }
      el._play = play;
      el._pause = function () { if (timer) { window.clearTimeout(timer); timer = null; } };
      el._resume = schedule;
      window.setTimeout(function () { play(); schedule(); }, 800 + idx * 850);
    });

    // One trigger per input type, discriminated by pointerType rather than a
    // (hover: hover) media query — devices with a hovering stylus (e.g. the
    // Galaxy S24 Ultra's S Pen) report hover:hover even though the user taps
    // with a finger, which would otherwise trap touch in the hover path (plays
    // once, then needs a mouseleave elsewhere before it can replay).
    //   - mouse / pen hover: replay on enter, restore the loop on leave.
    //   - finger touch: replay on every tap, then restart the loop clock.
    // We never bind "click", so a tap doesn't double-fire and a desktop click
    // stays inert.
    Array.prototype.forEach.call(document.querySelectorAll("h2"), function (h2) {
      var gx = h2.querySelector(".gx");
      if (!gx) return;
      h2.addEventListener("pointerenter", function (e) {
        if (e.pointerType === "touch") return; // touch handled below
        gx._pause(); gx._play();
      });
      h2.addEventListener("pointerleave", function (e) {
        if (e.pointerType === "touch") return;
        gx._pause(); gx._resume();
      });
      h2.addEventListener("touchstart", function () {
        gx._pause(); gx._play(); gx._resume();
      }, { passive: true });
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initHeaderHands);
  } else {
    initHeaderHands();
  }
})();
