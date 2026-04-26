// PWA: register service worker + capture install prompt.
(function () {
  'use strict';

  // Service worker registration (relative path so it works under any base).
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker
        .register('service-worker.js')
        .catch((err) => console.warn('SW registration failed:', err));
    });
  }

  // Capture the Android install prompt so we can fire it from the menu button.
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    if (window.MazeGame && typeof window.MazeGame.setInstallEvent === 'function') {
      window.MazeGame.setInstallEvent(e);
    }
  });

  window.addEventListener('appinstalled', () => {
    if (window.MazeGame && typeof window.MazeGame.setInstallEvent === 'function') {
      window.MazeGame.setInstallEvent(null);
    }
  });
})();
