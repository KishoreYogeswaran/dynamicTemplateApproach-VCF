/**
 * Preview mode for 1920×1080 scene HTML files.
 * 
 * Two approaches to preview scenes exactly as they'll look when stitched:
 * 
 * ══════════════════════════════════════════════════════════════════════
 * APPROACH 1: Add preview CSS/JS to base-layout.html (RECOMMENDED)
 * ══════════════════════════════════════════════════════════════════════
 * 
 * Add this CSS + JS snippet to your base-layout.html. It wraps the
 * 1920×1080 canvas in a scaled container that fits any browser window
 * while maintaining exact pixel proportions.
 * 
 * The preview wrapper:
 * - Locks the canvas to exactly 1920×1080
 * - Scales it down to fit your browser window (like a letterboxed video)
 * - Adds black bars (letterboxing) if aspect ratios don't match
 * - Shows a resolution badge so you know it's in preview mode
 * - Toggle with ?preview=false in URL to disable
 * 
 * ══════════════════════════════════════════════════════════════════════
 * APPROACH 2: Quick preview server (Node.js) 
 * ══════════════════════════════════════════════════════════════════════
 * 
 * Run: node preview-mode.js /path/to/output/dir
 * Opens a gallery of all scene HTMLs at http://localhost:3333
 */


// ─────────────────────────────────────────────────────────────────────
// APPROACH 1: Inject into base-layout.html
// ─────────────────────────────────────────────────────────────────────

/**
 * Add this CSS block inside the <style> tag in base-layout.html,
 * BEFORE the {{sceneCSS}} placeholder:
 */
export const PREVIEW_CSS = `
/* ═══ Preview Mode: Scale 1920×1080 canvas to fit browser window ═══ */
html.preview-mode {
  background: #000 !important;
  overflow: hidden !important;
  display: flex !important;
  align-items: center !important;
  justify-content: center !important;
  width: 100vw !important;
  height: 100vh !important;
  margin: 0 !important;
  padding: 0 !important;
}

html.preview-mode body {
  width: 1920px !important;
  height: 1080px !important;
  transform-origin: top left !important;
  /* Scale is set dynamically by JS */
  position: relative !important;
  overflow: hidden !important;
  flex-shrink: 0 !important;
}

/* Resolution badge */
.preview-badge {
  position: fixed;
  top: 12px;
  right: 12px;
  z-index: 99999;
  background: rgba(0, 0, 0, 0.75);
  color: #0f0;
  font-family: monospace;
  font-size: 11px;
  padding: 4px 10px;
  border-radius: 4px;
  pointer-events: none;
  backdrop-filter: blur(4px);
  border: 1px solid rgba(0, 255, 0, 0.2);
}

/* Scene boundary outline (helps see the exact 1920×1080 edges) */
html.preview-mode body::after {
  content: '';
  position: absolute;
  inset: 0;
  border: 1px dashed rgba(255, 255, 255, 0.08);
  pointer-events: none;
  z-index: 99998;
}
`;


/**
 * Add this JS block inside a <script> tag in base-layout.html,
 * BEFORE the {{sceneScript}} placeholder (so it runs first):
 */
export const PREVIEW_JS = `
// ═══ Preview Mode: Auto-scale 1920×1080 to fit browser ═══
(function initPreviewMode() {
  // Check URL param: ?preview=false disables it
  const params = new URLSearchParams(window.location.search);
  if (params.get('preview') === 'false') return;

  const CANVAS_W = 1920;
  const CANVAS_H = 1080;

  document.documentElement.classList.add('preview-mode');

  function rescale() {
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    // Scale to fit: pick the smaller scale factor
    const scale = Math.min(vw / CANVAS_W, vh / CANVAS_H);

    const body = document.body;
    body.style.transform = 'scale(' + scale + ')';

    // Center the scaled canvas
    const scaledW = CANVAS_W * scale;
    const scaledH = CANVAS_H * scale;
    const offsetX = (vw - scaledW) / 2;
    const offsetY = (vh - scaledH) / 2;
    body.style.marginLeft = offsetX + 'px';
    body.style.marginTop = offsetY + 'px';
  }

  // Add resolution badge
  function addBadge() {
    const badge = document.createElement('div');
    badge.className = 'preview-badge';
    badge.textContent = '🎬 Preview: 1920×1080 → scaled to fit';
    document.documentElement.appendChild(badge);
  }

  // Run on load and resize
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function() { rescale(); addBadge(); });
  } else {
    rescale();
    addBadge();
  }
  window.addEventListener('resize', rescale);
})();
`;


// ─────────────────────────────────────────────────────────────────────
// Helper: Inject preview mode into an existing HTML string
// ─────────────────────────────────────────────────────────────────────

/**
 * Takes a rendered scene HTML string and injects preview mode CSS/JS.
 * Use this if you don't want to modify base-layout.html permanently.
 * 
 * @param {string} html - The rendered scene HTML
 * @param {boolean} enabled - Whether to inject preview mode (default: true)
 * @returns {string} HTML with preview mode injected
 */
export function injectPreviewMode(html, enabled = true) {
    if (!enabled) return html;

    // Inject CSS before </style> (or before </head> if no style tag)
    if (html.includes('</style>')) {
        html = html.replace('</style>', `\n${PREVIEW_CSS}\n</style>`);
    } else {
        html = html.replace('</head>', `<style>${PREVIEW_CSS}</style>\n</head>`);
    }

    // Inject JS before </body>
    html = html.replace('</body>', `<script>${PREVIEW_JS}</script>\n</body>`);

    return html;
}


// ─────────────────────────────────────────────────────────────────────
// APPROACH 2: Standalone preview server
// ─────────────────────────────────────────────────────────────────────

/**
 * Run this file directly with Node.js to start a preview gallery:
 * 
 *   node preview-mode.js /path/to/scene/html/output/dir
 * 
 * Opens http://localhost:3333 with:
 * - Thumbnail grid of all scenes
 * - Click any scene to view it at exact 1920×1080 scale
 * - Arrow keys to navigate between scenes
 */

const GALLERY_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Scene Preview Gallery</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    background: #0a0a0a;
    color: #e0e0e0;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    padding: 32px;
  }
  h1 {
    font-size: 24px;
    font-weight: 600;
    margin-bottom: 8px;
    color: #fff;
  }
  .subtitle {
    font-size: 14px;
    color: #888;
    margin-bottom: 32px;
  }
  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(380px, 1fr));
    gap: 20px;
  }
  .card {
    background: #1a1a1a;
    border: 1px solid #2a2a2a;
    border-radius: 12px;
    overflow: hidden;
    cursor: pointer;
    transition: all 0.2s ease;
  }
  .card:hover {
    border-color: #4a9eff;
    transform: translateY(-2px);
    box-shadow: 0 8px 24px rgba(74, 158, 255, 0.15);
  }
  .card-preview {
    width: 100%;
    aspect-ratio: 16/9;
    background: #111;
    position: relative;
    overflow: hidden;
  }
  .card-preview iframe {
    width: 1920px;
    height: 1080px;
    transform-origin: top left;
    border: none;
    pointer-events: none;
  }
  .card-info {
    padding: 14px 16px;
    display: flex;
    justify-content: space-between;
    align-items: center;
  }
  .card-name {
    font-size: 14px;
    font-weight: 500;
    color: #ccc;
  }
  .card-type {
    font-size: 11px;
    padding: 3px 8px;
    border-radius: 4px;
    background: #2a2a2a;
    color: #888;
  }
  .fullscreen-overlay {
    display: none;
    position: fixed;
    inset: 0;
    background: #000;
    z-index: 10000;
    align-items: center;
    justify-content: center;
  }
  .fullscreen-overlay.active { display: flex; }
  .fullscreen-overlay iframe {
    width: 1920px;
    height: 1080px;
    transform-origin: center center;
    border: none;
  }
  .close-btn {
    position: fixed;
    top: 16px;
    right: 16px;
    z-index: 10001;
    background: rgba(255,255,255,0.1);
    border: 1px solid rgba(255,255,255,0.2);
    color: #fff;
    width: 40px;
    height: 40px;
    border-radius: 50%;
    font-size: 18px;
    cursor: pointer;
    display: none;
    align-items: center;
    justify-content: center;
    backdrop-filter: blur(8px);
  }
  .close-btn.active { display: flex; }
  .nav-hint {
    position: fixed;
    bottom: 16px;
    left: 50%;
    transform: translateX(-50%);
    z-index: 10001;
    background: rgba(0,0,0,0.7);
    color: #888;
    font-size: 12px;
    padding: 6px 14px;
    border-radius: 20px;
    display: none;
    backdrop-filter: blur(4px);
  }
  .nav-hint.active { display: block; }
</style>
</head>
<body>
  <h1>🎬 Scene Preview Gallery</h1>
  <p class="subtitle">Click any scene to view at full 1920×1080. Arrow keys ← → to navigate. ESC to close.</p>
  <div class="grid" id="grid"></div>
  
  <div class="fullscreen-overlay" id="overlay">
    <iframe id="fullframe" sandbox="allow-scripts allow-same-origin"></iframe>
  </div>
  <button class="close-btn" id="closeBtn" onclick="closeFullscreen()">✕</button>
  <div class="nav-hint" id="navHint">← → Navigate  •  ESC Close</div>

  <script>
    const scenes = __SCENES_JSON__;
    let currentIdx = -1;

    const grid = document.getElementById('grid');
    const overlay = document.getElementById('overlay');
    const fullframe = document.getElementById('fullframe');
    const closeBtn = document.getElementById('closeBtn');
    const navHint = document.getElementById('navHint');

    scenes.forEach((scene, idx) => {
      const card = document.createElement('div');
      card.className = 'card';
      card.onclick = () => openFullscreen(idx);

      const preview = document.createElement('div');
      preview.className = 'card-preview';

      const iframe = document.createElement('iframe');
      iframe.src = scene.file;
      iframe.loading = 'lazy';
      // Scale iframe to fit the card preview
      const updateScale = () => {
        const w = preview.offsetWidth;
        const scale = w / 1920;
        iframe.style.transform = 'scale(' + scale + ')';
      };
      preview.appendChild(iframe);
      new ResizeObserver(updateScale).observe(preview);
      setTimeout(updateScale, 100);

      const info = document.createElement('div');
      info.className = 'card-info';
      info.innerHTML = '<span class="card-name">' + scene.name + '</span><span class="card-type">' + scene.type + '</span>';

      card.appendChild(preview);
      card.appendChild(info);
      grid.appendChild(card);
    });

    function openFullscreen(idx) {
      currentIdx = idx;
      fullframe.src = scenes[idx].file + '?preview=false';
      overlay.classList.add('active');
      closeBtn.classList.add('active');
      navHint.classList.add('active');
      rescaleFullscreen();
    }

    function closeFullscreen() {
      overlay.classList.remove('active');
      closeBtn.classList.remove('active');
      navHint.classList.remove('active');
      fullframe.src = '';
      currentIdx = -1;
    }

    function rescaleFullscreen() {
      const scale = Math.min(window.innerWidth / 1920, window.innerHeight / 1080);
      fullframe.style.transform = 'scale(' + scale + ')';
    }

    window.addEventListener('resize', rescaleFullscreen);
    window.addEventListener('keydown', (e) => {
      if (currentIdx === -1) return;
      if (e.key === 'Escape') closeFullscreen();
      if (e.key === 'ArrowRight' && currentIdx < scenes.length - 1) openFullscreen(currentIdx + 1);
      if (e.key === 'ArrowLeft' && currentIdx > 0) openFullscreen(currentIdx - 1);
    });
  </script>
</body>
</html>`;


// ─────────────────────────────────────────────────────────────────────
// CLI: Run as standalone preview server
// ─────────────────────────────────────────────────────────────────────

async function startPreviewServer(dir) {
    const { createServer } = await import('http');
    const { readdir, readFile: rf } = await import('fs/promises');
    const { join: pjoin, extname } = await import('path');

    const PORT = 3333;
    const files = (await readdir(dir)).filter(f => f.endsWith('.html')).sort();

    if (files.length === 0) {
        console.error(`❌ No .html files found in: ${dir}`);
        process.exit(1);
    }

    const scenes = files.map(f => ({
        file: '/' + f,
        name: f.replace('.html', ''),
        type: f.includes('intro') ? 'intro' : f.includes('LO') ? 'objectives' : 'scene',
    }));

    const galleryHtml = GALLERY_HTML.replace('__SCENES_JSON__', JSON.stringify(scenes));

    const server = createServer(async (req, res) => {
        const url = new URL(req.url, 'http://localhost');
        const pathname = url.pathname;

        if (pathname === '/' || pathname === '/index.html') {
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(galleryHtml);
            return;
        }

        // Serve scene HTML files from the dir
        const filename = pathname.slice(1); // remove leading /
        if (files.includes(filename)) {
            const content = await rf(pjoin(dir, filename), 'utf-8');
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(content);
            return;
        }

        res.writeHead(404);
        res.end('Not found');
    });

    server.listen(PORT, () => {
        console.log(`\n🎬 Scene Preview Gallery`);
        console.log(`   ${files.length} scenes loaded from: ${dir}`);
        console.log(`   ➜ http://localhost:${PORT}\n`);
        console.log(`   Click any scene → fullscreen 1920×1080 preview`);
        console.log(`   Arrow keys ← → to navigate, ESC to close\n`);
    });
}

// CLI entry point
const isMainModule = import.meta.url === `file://${process.argv[1]}`;
if (isMainModule) {
    const dir = process.argv[2];
    if (!dir) {
        console.error('Usage: node preview-mode.js /path/to/scene/html/dir');
        process.exit(1);
    }
    startPreviewServer(dir);
}