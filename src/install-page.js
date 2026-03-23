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
      background: #0a0a0a;
      color: #e0e0e0;
      min-height: 100vh;
      display: flex;
      justify-content: center;
      align-items: center;
      padding: 24px;
    }
    .container {
      max-width: 640px;
      width: 100%;
      text-align: center;
    }
    .logo {
      width: 120px;
      height: 120px;
      border-radius: 24px;
      border: 2px solid #222;
      margin-bottom: 24px;
    }
    h1 {
      font-size: 2.4rem;
      font-weight: 700;
      color: #fff;
      margin-bottom: 4px;
    }
    .version {
      display: inline-block;
      background: #1a1a2e;
      color: #6a6aaa;
      font-size: 0.75rem;
      padding: 2px 10px;
      border-radius: 12px;
      margin-bottom: 16px;
    }
    .description {
      color: #999;
      font-size: 1.05rem;
      line-height: 1.6;
      margin-bottom: 32px;
    }
    .install-btn {
      display: inline-block;
      background: linear-gradient(135deg, #c33, #a22);
      color: #fff;
      font-size: 1.15rem;
      font-weight: 600;
      padding: 14px 48px;
      border-radius: 12px;
      text-decoration: none;
      transition: transform 0.15s, box-shadow 0.15s;
      box-shadow: 0 4px 20px rgba(204, 51, 51, 0.3);
    }
    .install-btn:hover {
      transform: translateY(-2px);
      box-shadow: 0 6px 28px rgba(204, 51, 51, 0.45);
    }
    .install-btn:active { transform: translateY(0) }
    .copy-section {
      margin-top: 20px;
      display: flex;
      gap: 8px;
      justify-content: center;
      align-items: center;
    }
    .copy-input {
      background: #111;
      border: 1px solid #333;
      color: #888;
      font-size: 0.8rem;
      padding: 8px 12px;
      border-radius: 8px;
      width: 340px;
      max-width: 65vw;
      text-align: center;
    }
    .copy-btn {
      background: #1a1a1a;
      border: 1px solid #333;
      color: #888;
      font-size: 0.8rem;
      padding: 8px 14px;
      border-radius: 8px;
      cursor: pointer;
      transition: all 0.2s;
    }
    .copy-btn:hover { color: #ccc; border-color: #555 }
    .divider {
      border: none;
      border-top: 1px solid #1a1a1a;
      margin: 36px 0;
    }
    .features {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 16px;
      text-align: left;
    }
    .feature {
      background: #111;
      border: 1px solid #1a1a1a;
      border-radius: 12px;
      padding: 16px;
    }
    .feature-icon { font-size: 1.4rem; margin-bottom: 6px }
    .feature-title { color: #ddd; font-weight: 600; font-size: 0.9rem; margin-bottom: 4px }
    .feature-desc { color: #666; font-size: 0.8rem; line-height: 1.4 }
    .footer {
      margin-top: 40px;
      color: #333;
      font-size: 0.75rem;
    }
    .footer a { color: #555; text-decoration: none }
    .footer a:hover { color: #888 }
    @media (max-width: 520px) {
      .features { grid-template-columns: 1fr }
      h1 { font-size: 1.8rem }
      .copy-input { width: 200px }
    }
  </style>
</head>
<body>
  <div class="container">
    <img src="/logo.jpg" alt="AniLibria" class="logo">
    <h1>AniLibria</h1>
    <span class="version">v${version}</span>
    <p class="description">
      Russian anime dub streams from <strong>AniLibria</strong>, directly in Stremio.<br>
      One-click install — no account required.
    </p>

    <a href="${INSTALL_URL}" class="install-btn">Install in Stremio</a>

    <div class="copy-section">
      <input class="copy-input" type="text" readonly value="${MANIFEST_URL}" id="manifest-url">
      <button class="copy-btn" id="copy-btn" onclick="
        navigator.clipboard.writeText(document.getElementById('manifest-url').value).then(function(){
          var b=document.getElementById('copy-btn');b.textContent='Copied!';setTimeout(function(){b.textContent='Copy'},1500);
        })
      ">Copy</button>
    </div>

    <hr class="divider">

    <div class="features">
      <div class="feature">
        <div class="feature-icon">\u{1F1F7}\u{1F1FA}</div>
        <div class="feature-title">Russian Dubs</div>
        <div class="feature-desc">Professional voice-over from AniLibria, one of the largest Russian anime dubbing teams.</div>
      </div>
      <div class="feature">
        <div class="feature-icon">\u{1F3AC}</div>
        <div class="feature-title">Multiple Qualities</div>
        <div class="feature-desc">Stream in 480p, 720p, or 1080p depending on availability.</div>
      </div>
      <div class="feature">
        <div class="feature-icon">\u{1F50D}</div>
        <div class="feature-title">Smart Matching</div>
        <div class="feature-desc">Automatic IMDB-to-AniLibria title resolution with fuzzy search fallback.</div>
      </div>
      <div class="feature">
        <div class="feature-icon">\u{1F4FA}</div>
        <div class="feature-title">Binge Support</div>
        <div class="feature-desc">Full series with all episodes — pick up right where you left off.</div>
      </div>
      <div class="feature">
        <div class="feature-icon">\u{26A1}</div>
        <div class="feature-title">No Account Needed</div>
        <div class="feature-desc">Just install and watch. No registration, no sign-in, no hassle.</div>
      </div>
      <div class="feature">
        <div class="feature-icon">\u{1F310}</div>
        <div class="feature-title">Works Everywhere</div>
        <div class="feature-desc">Compatible with all Stremio clients — desktop, mobile, and TV.</div>
      </div>
    </div>

    <div class="footer">
      <a href="/manifest.json">Manifest</a> &middot;
      <a href="/dashboard">Dashboard</a> &middot;
      AniLibria Stremio Addon
    </div>
  </div>
</body>
</html>`;
}

module.exports = renderInstallPage;
