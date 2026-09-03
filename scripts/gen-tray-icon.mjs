#!/usr/bin/env node
// Generates the menu bar icon: a cairn, three stacked stones.
//
// A TEMPLATE image — pure black plus alpha, no colour. macOS recolours a template icon for light
// mode, dark mode, and the pressed state; a coloured icon looks wrong in at least one of those and
// cannot be corrected at runtime. The `Template` suffix is also what Electron's nativeImage looks
// for, though main.ts calls setTemplateImage(true) explicitly rather than relying on the name.
//
// Output is committed, so running the app never depends on this script or on sharp being installed.
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import sharp from 'sharp'

const OUT_DIR = join(process.cwd(), 'apps', 'desktop', 'resources')

// 16pt canvas. Stones are ellipses, widest at the bottom, with a deliberate 1px gap between them so
// the shape still reads as a stack at 16px rather than blurring into one blob.
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16">
  <g fill="black">
    <ellipse cx="8" cy="12.4" rx="6.1" ry="2.1"/>
    <ellipse cx="8" cy="8.2"  rx="4.5" ry="1.9"/>
    <ellipse cx="8" cy="4.3"  rx="2.9" ry="1.7"/>
  </g>
</svg>`

mkdirSync(OUT_DIR, { recursive: true })

for (const [name, size] of [
  ['trayTemplate.png', 16],
  ['trayTemplate@2x.png', 32],
]) {
  const path = join(OUT_DIR, name)
  await sharp(Buffer.from(svg)).resize(size, size).png().toFile(path)
  console.log(`wrote ${path} (${size}x${size})`)
}
