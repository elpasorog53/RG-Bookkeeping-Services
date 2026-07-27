import { api, escapeHtml, toast } from '../app.js';

function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export async function render(root, { session }) {
  const isOwner = session.role === 'OWNER';

  root.innerHTML = `
    <div class="card">
      <h2>Upload media</h2>
      <input type="file" id="file-input" accept="image/jpeg,image/png,image/gif,image/webp,video/mp4" />
      <p class="empty-state">JPEG, PNG, GIF, WebP, or MP4. Up to 25MB.</p>
    </div>
    <div id="media-grid" class="media-grid"><p class="empty-state">Loading&hellip;</p></div>
  `;

  async function load() {
    const grid = document.getElementById('media-grid');
    try {
      const { media } = await api('/api/media');
      if (media.length === 0) {
        grid.innerHTML = '<p class="empty-state">No media uploaded yet.</p>';
        return;
      }
      grid.innerHTML = media
        .map(
          (m) => `
        <div class="media-tile">
          ${
            m.kind === 'image'
              ? `<img src="${escapeHtml(m.signedUrl)}" alt="${escapeHtml(m.file_name)}" />`
              : `<video src="${escapeHtml(m.signedUrl)}" controls></video>`
          }
          <div class="media-tile-meta">
            <span>${escapeHtml(m.file_name)}</span>
            <span class="empty-state">${formatBytes(m.byte_size)}</span>
          </div>
          ${isOwner ? `<button class="btn danger media-delete" data-id="${m.id}">Delete</button>` : ''}
        </div>
      `
        )
        .join('');

      grid.querySelectorAll('.media-delete').forEach((btn) => {
        btn.addEventListener('click', async () => {
          if (!window.confirm('Delete this file? This cannot be undone.')) return;
          await api(`/api/media/${btn.dataset.id}`, { method: 'DELETE' });
          toast('Deleted');
          load();
        });
      });
    } catch (err) {
      grid.innerHTML = `<p class="error-text">${escapeHtml(err.message)}</p>`;
    }
  }

  document.getElementById('file-input').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const formData = new FormData();
    formData.append('file', file);
    try {
      await api('/api/media/upload', { method: 'POST', body: formData });
      toast('Uploaded');
      e.target.value = '';
      load();
    } catch (err) {
      toast(err.message, { isError: true });
    }
  });

  await load();
}
