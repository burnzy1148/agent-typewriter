// Copies the shared images from the repository's images/ folder, so the README
// and the site always show the same files. The copies are gitignored.
import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const site = join(dirname(fileURLToPath(import.meta.url)), '..');
const images = join(site, '..', 'images');

const copies = [
  ['demo.gif', 'public/images/demo.gif'],
  ['banner.png', 'public/images/banner.png'],
  ['icon.png', 'public/images/icon.png'],
  ['icon.png', 'src/assets/icon.png'],
];

for (const [from, to] of copies) {
  const dest = join(site, to);
  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(join(images, from), dest);
}
