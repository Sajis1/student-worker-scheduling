// Replacement for window.confirm/alert. Native browser dialogs need the
// iframe sandbox's `allow-modals` permission - confirmed by testing that a
// sandboxed iframe without it makes confirm() silently return false with no
// dialog ever shown, which is exactly why a "Delete" button guarded by
// `if (!confirm(...)) return;` looked like it did nothing when this app is
// embedded in a Teams tab (same restriction that blocks downloads - see
// manager.js). These render as plain DOM elements instead, so they work
// identically in a normal browser tab and inside any iframe sandbox.

function ensureModalRoot() {
  let root = document.getElementById('app-modal-root');
  if (!root) {
    root = document.createElement('div');
    root.id = 'app-modal-root';
    document.body.appendChild(root);
  }
  return root;
}

function showModal(message, showCancel, variant) {
  return new Promise((resolve) => {
    const root = ensureModalRoot();
    root.innerHTML = `
      <div class="app-modal-overlay">
        <div class="app-modal-box${variant ? ` app-modal-${variant}` : ''}" role="alertdialog" aria-modal="true">
          <p class="app-modal-message"></p>
          <div class="app-modal-actions">
            ${showCancel ? '<button type="button" class="app-modal-cancel">Cancel</button>' : ''}
            <button type="button" class="app-modal-ok">OK</button>
          </div>
        </div>
      </div>
    `;
    root.querySelector('.app-modal-message').textContent = message;

    const cleanup = (result) => {
      document.removeEventListener('keydown', onKeydown);
      root.innerHTML = '';
      resolve(result);
    };
    const onKeydown = (e) => {
      if (e.key === 'Escape') cleanup(false);
      if (e.key === 'Enter') cleanup(true);
    };

    root.querySelector('.app-modal-ok').addEventListener('click', () => cleanup(true));
    if (showCancel) {
      root.querySelector('.app-modal-cancel').addEventListener('click', () => cleanup(false));
    }
    document.addEventListener('keydown', onKeydown);
    root.querySelector('.app-modal-ok').focus();
  });
}

function appConfirm(message, variant) {
  return showModal(message, true, variant);
}

function appAlert(message) {
  return showModal(message, false);
}

// Tutorial-video popup. Plain DOM for the same reason as showModal above:
// window.open() is blocked inside the Teams iframe sandbox, so a real popup
// window is out. `embedUrl` is whatever the video host's "embed" option gives:
//   YouTube (unlisted):  https://www.youtube.com/embed/VIDEO_ID
//   Microsoft Stream / SharePoint:  the src="" URL from its Embed <iframe> snippet
//   Vimeo:  https://player.vimeo.com/video/VIDEO_ID
// Closing the modal blanks the iframe, which stops playback.
//
// Exception: when this app is itself running inside an iframe (the Teams
// tab case), putting the video in a *second*, nested iframe breaks hosts
// like Panopto whose player needs a top-level sign-in/SSO redirect - that
// redirect can't complete inside a sandboxed grandchild frame, so the video
// silently never loads even though the exact same embed works fine in a
// normal browser tab. Detect that case and hand off to a real link click
// instead, which Teams does let escape the tab's iframe into the browser.
function showVideoModal(embedUrl, title) {
  if (window.self !== window.top) {
    const link = document.createElement('a');
    link.href = embedUrl;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    document.body.appendChild(link);
    link.click();
    link.remove();
    return;
  }

  const root = ensureModalRoot();
  root.innerHTML = `
    <div class="app-modal-overlay app-modal-overlay-video">
      <div class="app-modal-box app-modal-video" role="dialog" aria-modal="true">
        <div class="app-modal-video-bar">
          <span class="app-modal-video-title"></span>
          <button type="button" class="app-modal-video-close" aria-label="Close">&times;</button>
        </div>
        <div class="app-modal-video-frame">
          <iframe allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; fullscreen"
                  allowfullscreen referrerpolicy="strict-origin-when-cross-origin"></iframe>
        </div>
      </div>
    </div>
  `;
  root.querySelector('.app-modal-video-title').textContent = title || 'Tutorial';
  const iframe = root.querySelector('.app-modal-video-frame iframe');
  iframe.title = title || 'Tutorial video';
  iframe.src = embedUrl;

  const cleanup = () => {
    document.removeEventListener('keydown', onKeydown);
    root.innerHTML = ''; // blanks the iframe -> stops playback
  };
  const onKeydown = (e) => {
    if (e.key === 'Escape') cleanup();
  };

  root.querySelector('.app-modal-video-close').addEventListener('click', cleanup);
  root.querySelector('.app-modal-overlay-video').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) cleanup();
  });
  document.addEventListener('keydown', onKeydown);
  root.querySelector('.app-modal-video-close').focus();
}
