#!/usr/bin/env node
// Render the built HTML: PDFs for the A4 book and the comp card, plus review screenshots of the web page.
// Usage: node mappe/render.js [dist] [--shots] [--no-pdf]
const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright');

const args = process.argv.slice(2);
const dist = path.resolve(args.find((a) => !a.startsWith('--')) || 'dist');
const wantShots = args.includes('--shots');
const wantPdf = !args.includes('--no-pdf');

async function settle(page) {
  await page.evaluate(() => document.fonts.ready);
  await page.evaluate(() => Promise.all([...document.images].map((i) => (i.complete ? null : new Promise((r) => { i.onload = i.onerror = r; })))));
  await page.waitForTimeout(400);
}

(async () => {
  const launch = process.env.HTTPS_PROXY ? { proxy: { server: process.env.HTTPS_PROXY } } : {};
  const browser = await chromium.launch(launch);
  const info = JSON.parse(fs.readFileSync(path.join(dist, 'build.json'), 'utf8'));

  if (wantPdf) {
    const jobs = [
      ['portfolio.html', `${info.slug}-Portfolio.pdf`],
      ['portfolio-mail.html', `${info.slug}-Portfolio-email.pdf`],
      ['compcard.html', `${info.slug}-Compcard.pdf`],
    ];
    for (const [src, out] of jobs) {
      const file = path.join(dist, 'print', src);
      if (!fs.existsSync(file)) continue;
      const page = await browser.newPage();
      await page.goto('file://' + file);
      await settle(page);
      await page.waitForFunction(() => document.documentElement.dataset.ready === '1', null, { timeout: 15000 });
      await page.pdf({ path: path.join(dist, out), preferCSSPageSize: true, printBackground: true });
      await page.close();
      console.log('pdf', out, (fs.statSync(path.join(dist, out)).size / 1e6).toFixed(1) + ' MB');
    }
  }

  if (wantShots) {
    const shots = path.join(dist, 'shots');
    fs.mkdirSync(shots, { recursive: true });
    const views = [
      ['phone-light', { width: 390, height: 844 }, 'light'],
      ['phone-dark', { width: 390, height: 844 }, 'dark'],
      ['desk-light', { width: 1440, height: 900 }, 'light'],
      ['desk-dark', { width: 1440, height: 900 }, 'dark'],
    ];
    for (const [name, viewport, scheme] of views) {
      const page = await browser.newPage({ viewport, colorScheme: scheme, deviceScaleFactor: 1 });
      await page.goto('file://' + path.join(dist, 'web', 'preview.html'));
      // lazy images only load once scrolled into view
      await page.evaluate(async () => { for (let y = 0; y < document.body.scrollHeight; y += 600) { scrollTo(0, y); await new Promise((r) => setTimeout(r, 40)); } scrollTo(0, 0); });
      await settle(page);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
      await page.screenshot({ path: path.join(shots, name + '.png'), fullPage: true });
      console.log('shot', name, 'overflow-x', overflow);
      await page.close();
    }
  }
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
