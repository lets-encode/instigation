// Pre-paint theme init. Loaded as a synchronous <script src> in app.html's
// <head> so it runs before first paint — no wrong-theme flash. An external
// same-origin file (not an inline script) so the app's strict hash-mode CSP
// (script-src 'self') permits it. An explicit choice from the bulb toggle wins;
// otherwise the app defaults to light. Only the user's pick is stored, under a
// single localStorage key — a functional preference, no tracking.
(function () {
	var stored = null;
	try {
		stored = localStorage.getItem('theme');
	} catch (e) {}
	var theme = stored === 'dark' ? 'dark' : 'light';
	document.documentElement.dataset.theme = theme;
	document.documentElement.style.colorScheme = theme;
})();
