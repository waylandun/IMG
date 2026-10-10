export function initTheme({ root = document.documentElement, media = window.matchMedia('(prefers-color-scheme: dark)'), target = window } = {}) {
  let hostTheme;
  const apply = () => {
    const theme = hostTheme || (media.matches ? 'dark' : 'light');
    root.dataset.imageboardTheme = theme;
    root.style.colorScheme = theme;
  };
  const setHostTheme = theme => { hostTheme = ['light', 'dark'].includes(theme) ? theme : undefined; apply(); };
  const receive = event => setHostTheme(event.detail?.theme);
  media.addEventListener('change', apply);
  target.addEventListener('imageboard-host-theme', receive);
  apply();
  return { setHostTheme, dispose() { media.removeEventListener('change', apply); target.removeEventListener('imageboard-host-theme', receive); } };
}
