const { version } = require('../package.json');

const MANIFEST_URL = 'https://anilibria-stremio.online/manifest.json';
const INSTALL_URL = 'stremio://anilibria-stremio.online/manifest.json';

function renderInstallPage() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="description" content="AniLibria Stremio Addon — Russian anime dub streams directly in Stremio. One-click install, no account required.">
  <title>AniLibria — Russian Anime Dubs for Stremio</title>
  <link rel="icon" href="/logo.jpg">
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0 }

    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #080810;
      color: #e0e0e0;
      min-height: 100vh;
      overflow-x: hidden;
    }

    /* Animated background */
    body::before {
      content: '';
      position: fixed;
      inset: 0;
      background:
        radial-gradient(ellipse 80% 60% at 20% 10%, rgba(120, 40, 140, 0.12) 0%, transparent 60%),
        radial-gradient(ellipse 60% 50% at 80% 80%, rgba(180, 30, 30, 0.10) 0%, transparent 55%),
        radial-gradient(ellipse 50% 40% at 50% 50%, rgba(40, 20, 80, 0.08) 0%, transparent 70%);
      pointer-events: none;
      z-index: 0;
    }

    .page {
      position: relative;
      z-index: 1;
      max-width: 860px;
      margin: 0 auto;
      padding: 48px 24px 64px;
    }

    /* ── Hero ── */
    .hero {
      text-align: center;
      margin-bottom: 56px;
    }
    .logo-wrap {
      position: relative;
      display: inline-block;
      margin-bottom: 28px;
    }
    .logo {
      width: 100px;
      height: 100px;
      border-radius: 22px;
      border: 1.5px solid #2a2a3a;
      display: block;
      position: relative;
      z-index: 1;
    }
    .logo-glow {
      position: absolute;
      inset: -10px;
      border-radius: 30px;
      background: radial-gradient(circle, rgba(180,40,40,0.25) 0%, transparent 70%);
      animation: pulse-glow 3s ease-in-out infinite;
      pointer-events: none;
    }
    @keyframes pulse-glow {
      0%, 100% { opacity: 0.6; transform: scale(1) }
      50% { opacity: 1; transform: scale(1.08) }
    }
    h1 {
      font-size: 2.8rem;
      font-weight: 800;
      color: #fff;
      letter-spacing: -0.5px;
      margin-bottom: 6px;
    }
    .subtitle {
      color: #888;
      font-size: 1.05rem;
      margin-bottom: 14px;
    }
    .subtitle strong { color: #bbb }
    .version-badge {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      background: rgba(255,255,255,0.04);
      border: 1px solid #2a2a3a;
      color: #666;
      font-size: 0.72rem;
      padding: 3px 12px;
      border-radius: 20px;
      margin-bottom: 36px;
      letter-spacing: 0.3px;
    }
    .version-dot {
      width: 5px; height: 5px;
      background: #cc3333;
      border-radius: 50%;
    }

    /* ── Install button ── */
    .install-wrap {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 14px;
    }
    .install-btn {
      display: inline-flex;
      align-items: center;
      gap: 10px;
      background: linear-gradient(135deg, #cc3333 0%, #991a1a 100%);
      color: #fff;
      font-size: 1.1rem;
      font-weight: 700;
      padding: 15px 52px;
      border-radius: 14px;
      text-decoration: none;
      letter-spacing: 0.3px;
      box-shadow: 0 0 0 0 rgba(204, 51, 51, 0.4);
      animation: btn-pulse 2.5s ease-in-out infinite;
      transition: transform 0.15s, box-shadow 0.15s;
    }
    .install-btn svg { flex-shrink: 0 }
    @keyframes btn-pulse {
      0%, 100% { box-shadow: 0 4px 24px rgba(204, 51, 51, 0.35) }
      50% { box-shadow: 0 4px 36px rgba(204, 51, 51, 0.55), 0 0 0 6px rgba(204, 51, 51, 0.08) }
    }
    .install-btn:hover {
      transform: translateY(-2px);
      box-shadow: 0 8px 40px rgba(204, 51, 51, 0.5) !important;
      animation: none;
    }
    .install-btn:active { transform: translateY(0) }

    /* Copy row */
    .copy-row {
      display: flex;
      gap: 6px;
      align-items: center;
    }
    .copy-input {
      background: #0f0f18;
      border: 1px solid #22223a;
      color: #666;
      font-size: 0.78rem;
      font-family: 'SF Mono', 'Fira Code', monospace;
      padding: 9px 14px;
      border-radius: 9px;
      width: 320px;
      max-width: 60vw;
      text-align: center;
    }
    .copy-input:focus { outline: none; border-color: #444 }
    .copy-btn {
      background: #0f0f18;
      border: 1px solid #22223a;
      color: #666;
      font-size: 0.78rem;
      padding: 9px 14px;
      border-radius: 9px;
      cursor: pointer;
      transition: all 0.2s;
      white-space: nowrap;
    }
    .copy-btn:hover { color: #ccc; border-color: #444; background: #16162a }
    .copy-btn.copied { color: #5a9; border-color: #2a5a3a }

    .alt-install {
      color: #444;
      font-size: 0.78rem;
    }
    .alt-install a { color: #666; text-decoration: none }
    .alt-install a:hover { color: #aaa }

    /* ── Section divider ── */
    .section-divider {
      border: none;
      height: 1px;
      background: linear-gradient(to right, transparent, #1e1e2e 20%, #1e1e2e 80%, transparent);
      margin: 52px 0;
    }

    /* ── Steps ── */
    .steps-title {
      text-align: center;
      font-size: 1.3rem;
      font-weight: 700;
      color: #ddd;
      margin-bottom: 28px;
    }
    .steps {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 16px;
      margin-bottom: 0;
    }
    .step {
      background: #0e0e1a;
      border: 1px solid #1a1a2e;
      border-radius: 14px;
      padding: 22px 18px;
      position: relative;
      overflow: hidden;
    }
    .step::before {
      content: '';
      position: absolute;
      top: 0; left: 0; right: 0;
      height: 2px;
      background: linear-gradient(to right, #cc3333, #7b3fa0);
    }
    .step-num {
      font-size: 0.7rem;
      font-weight: 700;
      color: #cc3333;
      letter-spacing: 1px;
      text-transform: uppercase;
      margin-bottom: 8px;
    }
    .step-title {
      font-size: 0.95rem;
      font-weight: 700;
      color: #ddd;
      margin-bottom: 6px;
    }
    .step-desc {
      font-size: 0.8rem;
      color: #555;
      line-height: 1.5;
    }

    /* ── Features ── */
    .features-title {
      text-align: center;
      font-size: 1.3rem;
      font-weight: 700;
      color: #ddd;
      margin-bottom: 28px;
    }
    .features {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 14px;
    }
    .feature {
      background: #0e0e1a;
      border: 1px solid #1a1a2e;
      border-left: 3px solid transparent;
      border-radius: 12px;
      padding: 18px 16px;
      transition: border-color 0.2s, background 0.2s;
    }
    .feature:nth-child(1) { border-left-color: #cc4444 }
    .feature:nth-child(2) { border-left-color: #aa44cc }
    .feature:nth-child(3) { border-left-color: #4466cc }
    .feature:nth-child(4) { border-left-color: #44aacc }
    .feature:nth-child(5) { border-left-color: #44cc88 }
    .feature:nth-child(6) { border-left-color: #ccaa44 }
    .feature:hover { background: #121220; border-top-color: #252535; border-right-color: #252535; border-bottom-color: #252535 }
    .feature-icon { font-size: 1.3rem; margin-bottom: 8px; line-height: 1 }
    .feature-title { color: #ccc; font-weight: 700; font-size: 0.88rem; margin-bottom: 5px }
    .feature-desc { color: #555; font-size: 0.78rem; line-height: 1.5 }

    /* ── Footer ── */
    .footer {
      margin-top: 56px;
      text-align: center;
      padding-top: 24px;
      border-top: 1px solid #111122;
    }
    .footer-links {
      display: flex;
      justify-content: center;
      gap: 20px;
      flex-wrap: wrap;
      margin-bottom: 12px;
    }
    .footer-links a {
      color: #444;
      text-decoration: none;
      font-size: 0.78rem;
      transition: color 0.2s;
    }
    .footer-links a:hover { color: #999 }
    .footer-copy {
      color: #2a2a3a;
      font-size: 0.7rem;
    }

    /* ── Responsive ── */
    @media (max-width: 680px) {
      h1 { font-size: 2rem }
      .steps, .features { grid-template-columns: 1fr }
      .copy-input { width: 180px }
      .page { padding: 36px 16px 48px }
    }
    @media (max-width: 480px) {
      .install-btn { padding: 14px 36px; font-size: 1rem }
    }
  </style>
</head>
<body>
  <div class="page">

    <!-- Hero -->
    <div class="hero">
      <div class="logo-wrap">
        <div class="logo-glow"></div>
        <img src="/logo.jpg" alt="AniLibria" class="logo">
      </div>
      <h1>AniLibria</h1>
      <p class="subtitle">Russian anime dubs from <strong>AniLibria</strong>, directly in Stremio.</p>
      <div class="version-badge">
        <span class="version-dot"></span>
        v${version}
      </div>

      <div class="install-wrap">
        <a href="${INSTALL_URL}" class="install-btn">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 14.5v-9l6 4.5-6 4.5z" fill="white"/>
          </svg>
          Install in Stremio
        </a>

        <div class="copy-row">
          <input class="copy-input" type="text" readonly value="${MANIFEST_URL}" id="manifest-url">
          <button class="copy-btn" id="copy-btn" onclick="
            navigator.clipboard.writeText(document.getElementById('manifest-url').value).then(function(){
              var b=document.getElementById('copy-btn');
              b.textContent='Copied!';
              b.classList.add('copied');
              setTimeout(function(){ b.textContent='Copy'; b.classList.remove('copied') }, 1800);
            })
          ">Copy</button>
        </div>

        <p class="alt-install">
          Also on <a href="https://stremio-addons.net/addons/anilibria" target="_blank" rel="noopener">stremio-addons.net</a>
          &nbsp;·&nbsp;
          Or paste the URL in Stremio → Addons → <em>Add addon</em>
        </p>
      </div>
    </div>

    <hr class="section-divider">

    <!-- How to install -->
    <p class="steps-title">How to Install</p>
    <div class="steps">
      <div class="step">
        <div class="step-num">Step 1</div>
        <div class="step-title">Click Install</div>
        <div class="step-desc">Press the button above — your browser will open Stremio automatically.</div>
      </div>
      <div class="step">
        <div class="step-num">Step 2</div>
        <div class="step-title">Confirm in Stremio</div>
        <div class="step-desc">Stremio will show a confirmation dialog. Click <em>Install</em> to add the addon.</div>
      </div>
      <div class="step">
        <div class="step-num">Step 3</div>
        <div class="step-title">Watch Anime</div>
        <div class="step-desc">Open any anime, select an episode, and pick an <strong>AniLibria</strong> stream from the list.</div>
      </div>
    </div>

    <hr class="section-divider">

    <!-- Features -->
    <p class="features-title">Features</p>
    <div class="features">
      <div class="feature">
        <div class="feature-icon">\u{1F1F7}\u{1F1FA}</div>
        <div class="feature-title">Russian Dubs</div>
        <div class="feature-desc">Professional voice-over from AniLibria, one of the largest Russian anime dubbing studios.</div>
      </div>
      <div class="feature">
        <div class="feature-icon">\u{1F3AC}</div>
        <div class="feature-title">Multiple Qualities</div>
        <div class="feature-desc">480p, 720p, and 1080p HLS streams — pick what works best for your connection.</div>
      </div>
      <div class="feature">
        <div class="feature-icon">\u{1F50D}</div>
        <div class="feature-title">Smart Matching</div>
        <div class="feature-desc">4-step IMDB-to-AniLibria resolution: alias → search API → Fuse.js fuzzy → cache.</div>
      </div>
      <div class="feature">
        <div class="feature-icon">\u{1F4FA}</div>
        <div class="feature-title">Binge Support</div>
        <div class="feature-desc">Full series with all episodes. Auto-continue to the next episode seamlessly.</div>
      </div>
      <div class="feature">
        <div class="feature-icon">\u{26A1}</div>
        <div class="feature-title">No Account Needed</div>
        <div class="feature-desc">Zero sign-up. Just install and start watching — completely free.</div>
      </div>
      <div class="feature">
        <div class="feature-icon">\u{1F310}</div>
        <div class="feature-title">All Platforms</div>
        <div class="feature-desc">Works on every Stremio client — desktop, web, Android, iOS, and TV.</div>
      </div>
    </div>

    <!-- Footer -->
    <div class="footer">
      <div class="footer-links">
        <a href="/manifest.json">Manifest JSON</a>
        <a href="/dashboard">Dashboard</a>
        <a href="/debug">Debug</a>
        <a href="https://stremio-addons.net/addons/anilibria" target="_blank" rel="noopener">Stremio Community</a>
        <a href="https://anilibria.top" target="_blank" rel="noopener">AniLibria</a>
      </div>
      <div class="footer-copy">AniLibria Stremio Addon &middot; Not affiliated with AniLibria or Stremio</div>
    </div>

  </div>
</body>
</html>`;
}

module.exports = renderInstallPage;
