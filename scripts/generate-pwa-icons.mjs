/**
 * Generates PWA assets:
 *   - pwa-192.png, pwa-512.png         — standard "any" purpose icons
 *   - pwa-maskable-512.png             — maskable icon with ~20% safe-zone padding
 *                                        and theme-coloured background so Android can
 *                                        crop without clipping the logo
 *   - apple-touch-icon.png             — 180px iOS home-screen icon
 *   - pwa-screenshot-wide.png          — 1280x720 branded placeholder for desktop installer
 *   - pwa-screenshot-narrow.png        — 720x1280 branded placeholder for mobile installer
 *
 * Source images:
 *   public/favicon.png       — square colour mark, used for the standard icons
 *   public/white logo.png    — light mark on transparent bg, used for maskable + screenshots
 *
 * Run: npm run generate:pwa-icons
 */
import sharp from "sharp";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const publicDir = path.join(root, "public");
const colorIcon = path.join(publicDir, "favicon.png");
const whiteLogo = path.join(publicDir, "white logo.png");

// Keep in sync with vite.config.ts (UD_THEME) — maskable icon backdrop only.
const THEME = "#0A2342";

// Brand green gradient — mirrors `.gradient-primary` in src/index.css:
//   linear-gradient(135deg, hsl(100 42% 45%), hsl(100 50% 50%))
// Used for the install-card screenshot placeholders so they match the in-app aesthetic.
const BRAND_GREEN_PRIMARY = "#63A343";
const BRAND_GREEN_SECONDARY = "#6ABF40";

const standardIcons = [
  ["pwa-192.png", 192],
  ["pwa-512.png", 512],
  ["apple-touch-icon.png", 180],
];

for (const [name, size] of standardIcons) {
  await sharp(colorIcon).resize(size, size, { fit: "cover" }).png().toFile(path.join(publicDir, name));
  console.log("wrote public/" + name);
}

/**
 * Maskable icon — Android applies an arbitrary mask (circle / squircle / rounded square)
 * and crops up to ~20% of each edge. We render the logo at 60% of the canvas, centred,
 * on a solid theme-coloured background so the brand mark is always inside the safe zone.
 * @see https://web.dev/maskable-icon/
 */
{
  const size = 512;
  const inner = Math.round(size * 0.6);
  const offset = Math.round((size - inner) / 2);
  const logoBuffer = await sharp(whiteLogo)
    .resize(inner, inner, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer();
  await sharp({
    create: {
      width: size,
      height: size,
      channels: 4,
      background: THEME,
    },
  })
    .composite([{ input: logoBuffer, top: offset, left: offset }])
    .png()
    .toFile(path.join(publicDir, "pwa-maskable-512.png"));
  console.log("wrote public/pwa-maskable-512.png");
}

/**
 * Screenshot placeholders — Chrome's richer install UI prefers `screenshots` entries.
 * These are intentionally branded fallbacks; replace them with real captures of the
 * dashboard whenever convenient and keep the same filenames + dimensions.
 */
async function writeScreenshot(name, width, height) {
  const logoMax = Math.round(Math.min(width, height) * 0.28);
  const titleSize = Math.round(Math.min(width, height) * 0.06);
  const subtitleSize = Math.round(Math.min(width, height) * 0.028);

  const logoBuffer = await sharp(whiteLogo)
    .resize(logoMax, logoMax, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer();

  const overlaySvg = Buffer.from(
    `<?xml version="1.0" encoding="UTF-8"?>
    <svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
      <defs>
        <!-- 135deg brand gradient (top-left -> bottom-right), matches .gradient-primary -->
        <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stop-color="${BRAND_GREEN_PRIMARY}"/>
          <stop offset="100%" stop-color="${BRAND_GREEN_SECONDARY}"/>
        </linearGradient>
        <!-- Soft radial darken behind the foreground for legibility on the lighter side of the gradient -->
        <radialGradient id="vignette" cx="50%" cy="50%" r="60%">
          <stop offset="0%" stop-color="rgba(0,0,0,0.18)"/>
          <stop offset="65%" stop-color="rgba(0,0,0,0.05)"/>
          <stop offset="100%" stop-color="rgba(0,0,0,0)"/>
        </radialGradient>
      </defs>
      <rect width="100%" height="100%" fill="url(#bg)"/>
      <rect width="100%" height="100%" fill="url(#vignette)"/>
      <text x="50%" y="${Math.round(height * 0.68)}" text-anchor="middle"
            fill="#ffffff" font-family="Inter, Helvetica, Arial, sans-serif"
            font-size="${titleSize}" font-weight="700">Unique Distribution CRM</text>
      <text x="50%" y="${Math.round(height * 0.76)}" text-anchor="middle"
            fill="rgba(255,255,255,0.82)" font-family="Inter, Helvetica, Arial, sans-serif"
            font-size="${subtitleSize}" font-weight="400">Sales · Inventory · Orders · Team operations</text>
    </svg>`,
  );

  const logoTop = Math.round(height * 0.22);
  const logoLeft = Math.round((width - logoMax) / 2);

  await sharp(overlaySvg)
    .composite([{ input: logoBuffer, top: logoTop, left: logoLeft }])
    .png()
    .toFile(path.join(publicDir, name));
  console.log("wrote public/" + name);
}

await writeScreenshot("pwa-screenshot-wide.png", 1280, 720);
await writeScreenshot("pwa-screenshot-narrow.png", 720, 1280);
