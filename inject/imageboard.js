(() => {
  'use strict';
  const KEY = '__codexImageboard__';
  const VERSION = '0.4.1';
  if (window[KEY]?.version === VERSION) { window[KEY].refresh(); return; }
  window[KEY]?.destroy?.();
  const OWN = 'data-imageboard-owned';
  let entry, panel, timer, observer, frame, ready = false, opened = false, destroyed = false;
  const disposers = [];

  function navigation() {
    const rail = document.querySelector('nav[data-app-navigation-rail]');
    if (rail) {
      const reference = [...rail.querySelectorAll('button')].find(button =>
        !button.hasAttribute(OWN) && /^(探索|explore)$/i.test((button.querySelector('.sr-only')?.textContent || button.getAttribute('aria-label') || button.textContent).trim()));
      if (reference) return { reference, before: true };
    }
    const buttons = [...document.querySelectorAll('nav button, aside button, [data-sidebar] button, nav a, aside a')];
    const reference = buttons.find(button => !button.hasAttribute(OWN) && /^(插件|plugins)$/i.test((button.textContent || button.getAttribute('aria-label') || '').trim()));
    return reference ? { reference, before: false } : null;
  }

  function makeEntry(reference) {
    const button = reference.cloneNode(true);
    button.id = 'codex-imageboard-entry';
    button.setAttribute(OWN, 'true');
    for (const attr of ['href', 'disabled', 'aria-current', 'aria-expanded', 'aria-controls', 'aria-haspopup', 'data-state', 'data-sidebar-destination', 'data-selected']) button.removeAttribute(attr);
    for (const child of button.querySelectorAll('[id]')) child.removeAttribute('id');
    button.setAttribute('aria-label', '生图面板');
    button.setAttribute('title', '生图面板');
    if (button.tagName === 'BUTTON') button.type = 'button';
    const label = button.querySelector('.sr-only');
    if (label) label.textContent = '生图面板';
    else {
      const walker = document.createTreeWalker(button, NodeFilter.SHOW_TEXT);
      let node;
      while ((node = walker.nextNode())) if (node.textContent.trim()) node.textContent = '生图面板';
    }
    const svg = button.querySelector('svg');
    if (svg) {
      svg.setAttribute('viewBox', '0 0 24 24');
      svg.setAttribute('fill', 'none'); svg.setAttribute('stroke', 'currentColor'); svg.setAttribute('stroke-width', '1.6');
      svg.innerHTML = '<rect x="3" y="3" width="18" height="18" rx="4"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="m3 16 5-5 5 5 4-4 4 4"/>';
    }
    button.addEventListener('click', event => { event.preventDefault(); event.stopPropagation(); open(); });
    return button;
  }

  function position() {
    if (!panel || !opened) return;
    const host = document.querySelector('.app-shell-main-content-frame') || document.querySelector('[data-app-shell-main-content-layout]') || document.querySelector('main');
    const rail = document.querySelector('nav[data-app-navigation-rail]') || entry?.closest('aside, nav');
    const rect = host?.getBoundingClientRect();
    const left = rect?.width > 200 ? Math.max(rect.left, rail?.getBoundingClientRect().right || 0) : rail?.getBoundingClientRect().right || 260;
    const top = rect?.height > 200 ? Math.max(0, rect.top) : 48;
    const css = `position:fixed;left:${left}px;top:${top}px;right:0;bottom:0;z-index:100;background:white;display:flex;flex-direction:column;-webkit-app-region:no-drag;`;
    if (panel.style.cssText !== css) {
      // Individual comparisons avoid an observer loop caused by CSS serialization.
      panel.style.position = 'fixed'; panel.style.left = `${left}px`; panel.style.top = `${top}px`;
      panel.style.right = '0'; panel.style.bottom = '0'; panel.style.zIndex = '100'; panel.style.background = 'white';
      panel.style.display = 'flex'; panel.style.flexDirection = 'column'; panel.style.setProperty('-webkit-app-region', 'no-drag');
    }
  }

  function open() {
    if (destroyed) return;
    opened = true;
    if (!panel) {
      panel = document.createElement('section'); panel.id = 'codex-imageboard-panel'; panel.setAttribute(OWN, 'true'); panel.setAttribute('aria-label', '生图面板');
      frame = document.createElement('iframe'); frame.name = `codex-imageboard-${crypto.randomUUID()}`; frame.src = 'about:blank'; frame.title = 'Imageboard 生图工作室'; frame.setAttribute('sandbox', 'allow-scripts allow-downloads'); frame.setAttribute('allow', 'clipboard-write'); frame.referrerPolicy = 'no-referrer'; frame.style.cssText = 'width:100%;flex:1;min-height:0;border:0;';
      panel.append(frame); document.body.append(panel);
    }
    panel.hidden = false;
    entry?.setAttribute('aria-current', 'page'); position();
  }
  function close() { opened = false; if (panel) { panel.hidden = true; panel.style.display = 'none'; } entry?.removeAttribute('aria-current'); }
  function refresh() {
    if (destroyed) return;
    const target = navigation();
    if (target) {
      if (!entry) entry = makeEntry(target.reference);
      if (entry.parentElement !== target.reference.parentElement || (target.before ? entry.nextElementSibling !== target.reference : entry.previousElementSibling !== target.reference)) {
        if (target.before) target.reference.before(entry); else target.reference.after(entry);
      }
    }
    if (opened) { if (panel && !panel.isConnected) document.body.append(panel); position(); }
  }
  function schedule() { if (!timer) timer = setTimeout(() => { timer = null; refresh(); }, 150); }
  function destroy() {
    destroyed = true; clearTimeout(timer); observer?.disconnect();
    for (const dispose of disposers) dispose(); entry?.remove(); panel?.remove(); delete window[KEY];
  }
  function start() {
    refresh(); observer = new MutationObserver(schedule); observer.observe(document.documentElement, { childList: true, subtree: true });
    const resize = () => position(); window.addEventListener('resize', resize); disposers.push(() => window.removeEventListener('resize', resize));
    const click = event => { if (opened && event.target.closest('nav, aside, [data-sidebar]') && !event.target.closest(`[${OWN}]`)) close(); };
    document.addEventListener('click', click, true); disposers.push(() => document.removeEventListener('click', click, true));
    const message = event => {
      if (!frame || event.source !== frame.contentWindow || event.origin !== 'null') return;
      if (event.data?.type === 'codex-imageboard-ready') ready = true;
      if (event.data?.type === 'codex-imageboard-close') { close(); entry?.focus(); }
    };
    window.addEventListener('message', message); disposers.push(() => window.removeEventListener('message', message));
  }
  window[KEY] = { version: VERSION, open, close, refresh, destroy, get mounted() { return !!entry?.isConnected; }, get ready() { return ready; }, get frameName() { return frame?.name; } };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true }); else start();
})();
