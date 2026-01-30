/**
 * Generate app icons and tray icon.
 * - App/dock icon: calimero-app-icon.svg -> icon-1024.png -> all bundle formats
 * - Tray icon: calimero-tray-icon.svg -> tray-icon.png (menu bar)
 */
import sharp from 'sharp';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const iconsDir = join(__dirname, '../src-tauri/icons');

async function main() {
  // 1. App icon (1024x1024 for dock, .icns, .ico, etc.)
  const appSvg = readFileSync(join(iconsDir, 'calimero-app-icon.svg'));
  await sharp(appSvg)
    .resize(1024, 1024)
    .png()
    .toFile(join(iconsDir, 'icon-1024.png'));
  console.log('Created icon-1024.png');

  // 2. Tray icon (base - no checkmark)
  const traySvg = readFileSync(join(iconsDir, 'calimero-tray-icon.svg'));
  await sharp(traySvg)
    .resize(44, 44)
    .png()
    .toFile(join(iconsDir, 'tray-icon.png'));
  console.log('Created tray-icon.png');

  // 3. Tray icon with checkmark (node connected)
  const trayConnectedSvg = readFileSync(join(iconsDir, 'calimero-tray-icon-connected.svg'));
  await sharp(trayConnectedSvg)
    .resize(44, 44)
    .png()
    .toFile(join(iconsDir, 'tray-icon-connected.png'));
  console.log('Created tray-icon-connected.png');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
