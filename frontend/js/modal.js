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

function showModal(message, showCancel) {
  return new Promise((resolve) => {
    const root = ensureModalRoot();
    root.innerHTML = `
      <div class="app-modal-overlay">
        <div class="app-modal-box" role="alertdialog" aria-modal="true">
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

function appConfirm(message) {
  return showModal(message, true);
}

function appAlert(message) {
  return showModal(message, false);
}
