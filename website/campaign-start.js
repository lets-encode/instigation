// "Start a campaign" form: checks the typed name against the slug registry
// (GET /registry/api/slug/<name>, same-origin) as it is typed, then hands off
// to the app's onboarding wizard at /new?slug=<name>, which prefills the name
// and re-verifies it on Continue. Format rules mirror the registry's
// (broker/slug_validation.py): 3-40 chars, lowercase letters, digits, single
// internal hyphens.
(function () {
  var form = document.querySelector(".start-form");
  if (!form) return;
  var input = document.getElementById("start-name");
  var status = document.querySelector(".start-status");

  // Show the origin the page is actually served from, so staging and testing
  // instances name themselves rather than production.
  var origin = location.host;
  document.querySelectorAll("[data-origin]").forEach(function (el) {
    el.textContent = origin;
  });

  var SLUG_RE = /^[a-z0-9]([a-z0-9-]{1,38}[a-z0-9])?$/;
  var isValid = function (name) {
    return SLUG_RE.test(name) && name.indexOf("--") === -1;
  };

  var timer = null;
  var seq = 0; // discards responses of superseded checks
  var state = "idle"; // idle | invalid | checking | free | taken | unknown

  function show(kind, text, link) {
    status.hidden = false;
    status.className = "start-status is-" + kind;
    status.textContent = text;
    if (link) {
      status.appendChild(document.createTextNode(" "));
      var a = document.createElement("a");
      a.href = link.href;
      a.textContent = link.text;
      status.appendChild(a);
    }
  }

  function clearStatus() {
    status.hidden = true;
    status.textContent = "";
  }

  function update() {
    var name = input.value.trim();
    var mySeq = ++seq;
    clearTimeout(timer);
    if (!name) {
      state = "idle";
      clearStatus();
      return;
    }
    if (!isValid(name)) {
      state = "invalid";
      show("invalid", "Names must be 3–40 characters: lowercase letters, digits, and single internal hyphens.");
      return;
    }
    state = "checking";
    show("checking", "Checking availability…");
    timer = setTimeout(function () {
      fetch("/registry/api/slug/" + encodeURIComponent(name), {
        headers: { Accept: "application/json" },
        cache: "no-store"
      })
        .then(function (res) {
          if (!res.ok) throw new Error("registry " + res.status);
          return res.json();
        })
        .then(function (slug) {
          if (mySeq !== seq) return;
          if (slug.status === "free") {
            state = "free";
            show("free", origin + "/" + name + " is available.");
          } else if (slug.status === "active") {
            state = "taken";
            show("taken", "This campaign already exists —", {
              href: "/" + name,
              text: "visit " + origin + "/" + name
            });
          } else if (slug.status === "pending") {
            state = "taken";
            show("taken", "This name is being set up by someone right now.");
          } else {
            // reserved or tombstoned
            state = "taken";
            show("taken", "This name is not available for a campaign.");
          }
        })
        .catch(function () {
          if (mySeq !== seq) return;
          // The registry couldn't be reached: let the wizard settle it — it
          // verifies the name again before anything is created.
          state = "unknown";
          clearStatus();
        });
    }, 350);
  }

  input.addEventListener("input", update);

  form.addEventListener("submit", function (e) {
    e.preventDefault();
    var name = input.value.trim();
    if (!name || !isValid(name)) {
      update();
      input.focus();
      return;
    }
    if (state === "taken") return;
    // free, unknown, or still checking: the wizard re-verifies on Continue.
    location.href = "/new?slug=" + encodeURIComponent(name);
  });
})();
