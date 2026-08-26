/*
Applied before first paint so the JuAPI shell never flashes the wrong theme.
Kept as a classic script (not a module) for that reason, and same-origin so the
Worker's `script-src 'self'` CSP admits it without an inline hash.
*/
(function () {
  var STORAGE_KEY = 'juapi-theme';
  var stored = null;
  try {
    stored = window.localStorage.getItem(STORAGE_KEY);
  } catch (error) {
    stored = null;
  }
  var preferred =
    stored === 'dark' || stored === 'light'
      ? stored
      : window.matchMedia &&
          window.matchMedia('(prefers-color-scheme: dark)').matches
        ? 'dark'
        : 'light';
  document.documentElement.setAttribute('data-theme', preferred);
  document.documentElement.setAttribute(
    'data-theme-source',
    stored === 'dark' || stored === 'light' ? 'user' : 'system',
  );
})();
