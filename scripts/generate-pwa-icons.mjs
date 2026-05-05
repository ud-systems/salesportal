/**
 * Generates fixed-size PNGs from public/favicon.png for PWA / Apple touch icons.
 * Run: npm run generate:pwa-icons
 */
import sharp from "sharp";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const input = path.join(root, "public", "favicon.png");

const outputs = [
  ["pwa-192.png", 192],
  ["pwa-512.png", 512],
  ["apple-touch-icon.png", 180],
];

for (const [name, size] of outputs) {
  await sharp(input).resize(size, size, { fit: "cover" }).png().toFile(path.join(root, "public", name));
  console.log("wrote public/" + name);
}
