#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const PROJECT_DIR = path.dirname(__filename);
const SOURCE_HTML = path.join(PROJECT_DIR, 'index.html');
const FPS = 30;
const DURATION_SECONDS = 52.4;
const FRAME_COUNT = Math.round(FPS * DURATION_SECONDS);
const CSS_TICK_MS = 8;
const VIEWPORT = { width: 1080, height: 1350 };
const DEVICE_SCALE_FACTOR = 2;
const EARLY_CLOSING_CTA_MS = 49_200;
const FFMPEG = process.env.FFMPEG || 'ffmpeg';

function optionValue(name, fallback) {
  const prefix = `${name}=`;
  const item = process.argv.slice(2).find(arg => arg.startsWith(prefix));
  return item ? item.slice(prefix.length) : fallback;
}

const flags = new Set(process.argv.slice(2).filter(arg => !arg.includes('=')));
const smoke = flags.has('--smoke');
const clean = flags.has('--clean');
const encodeOnly = flags.has('--encode-only');
const renderOnly = flags.has('--render-only') || smoke;
const outputRoot = path.resolve(PROJECT_DIR, optionValue('--render-dir', smoke ? 'render-smoke' : 'render'));
const framesDir = path.join(outputRoot, 'frames');
const telemetryPath = path.join(outputRoot, 'capture-telemetry.jsonl');
const captureQaPath = path.join(outputRoot, 'capture-qa.json');
const manifestPath = path.join(outputRoot, 'manifest.json');
const masterPath = path.resolve(PROJECT_DIR, optionValue('--output', 'ep01-social-1080x1350-master.mp4'));
const diagnosticPath = path.resolve(PROJECT_DIR, optionValue('--diagnostic', 'ep01-seam-25.5-26.5-4x.mp4'));

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function loadPlaywright() {
  const require = createRequire(import.meta.url);
  const candidates = [];
  if (process.env.PLAYWRIGHT_MODULE) candidates.push(process.env.PLAYWRIGHT_MODULE);
  candidates.push('playwright');

  const runtimeNodeRoot = path.resolve(path.dirname(process.execPath), '..');
  const pnpmRoot = path.join(runtimeNodeRoot, 'node_modules', '.pnpm');
  if (fs.existsSync(pnpmRoot)) {
    const bundled = fs.readdirSync(pnpmRoot)
      .filter(name => /^playwright@/.test(name))
      .sort()
      .reverse();
    for (const name of bundled) {
      candidates.push(path.join(pnpmRoot, name, 'node_modules', 'playwright'));
    }
  }

  candidates.push('/Applications/ChatGPT.app/Contents/Resources/cua_node/lib/node_modules/playwright');

  const errors = [];
  for (const candidate of candidates) {
    try {
      return { module: require(candidate), resolvedPath: require.resolve(candidate) };
    } catch (error) {
      errors.push(`${candidate}: ${error.message}`);
    }
  }
  throw new Error(`Playwright could not be resolved. Set PLAYWRIGHT_MODULE.\n${errors.join('\n')}`);
}

function findChromium(chromium) {
  const candidates = [
    process.env.CHROMIUM_PATH,
    (() => {
      try { return chromium.executablePath(); } catch { return null; }
    })(),
    '/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ].filter(Boolean);
  const executablePath = candidates.find(candidate => fs.existsSync(candidate));
  if (!executablePath) {
    throw new Error(`No Chromium-family browser found. Checked:\n${candidates.join('\n')}`);
  }
  return executablePath;
}

function framePath(frameIndex) {
  return path.join(framesDir, `frame_${String(frameIndex + 1).padStart(6, '0')}.png`);
}

function pngDimensions(buffer) {
  if (buffer.length < 24 || buffer.toString('ascii', 1, 4) !== 'PNG') {
    throw new Error('First captured frame is not a PNG.');
  }
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

function runProcess(command, args, label) {
  return new Promise((resolve, reject) => {
    process.stdout.write(`\n${label}\n`);
    const child = spawn(command, args, { cwd: PROJECT_DIR, stdio: ['ignore', 'inherit', 'inherit'] });
    child.once('error', reject);
    child.once('exit', code => {
      if (code === 0) resolve();
      else reject(new Error(`${label} failed with exit code ${code}`));
    });
  });
}

async function encodeOutputs() {
  await runProcess(FFMPEG, [
    '-y',
    '-framerate', String(FPS),
    '-start_number', '1',
    '-i', path.join(framesDir, 'frame_%06d.png'),
    '-vf', 'scale=1080:1350:flags=lanczos,format=yuv420p,setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709',
    '-an',
    '-c:v', 'libx264',
    '-profile:v', 'high',
    '-crf', '17',
    '-preset', 'slow',
    '-tune', 'animation',
    '-x264-params', 'colorprim=bt709:transfer=bt709:colormatrix=bt709',
    '-r', String(FPS),
    '-fps_mode', 'cfr',
    '-force_key_frames', 'expr:eq(n,1497)',
    '-color_primaries', 'bt709',
    '-color_trc', 'bt709',
    '-colorspace', 'bt709',
    '-movflags', '+faststart',
    masterPath,
  ], `Encoding master: ${masterPath}`);

  await runProcess(FFMPEG, [
    '-y',
    '-i', masterPath,
    '-vf', 'trim=start=25.5:end=26.5,setpts=4*(PTS-STARTPTS),fps=30,setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709',
    '-an',
    '-c:v', 'libx264',
    '-profile:v', 'high',
    '-crf', '17',
    '-preset', 'slow',
    '-tune', 'animation',
    '-x264-params', 'colorprim=bt709:transfer=bt709:colormatrix=bt709',
    '-pix_fmt', 'yuv420p',
    '-color_primaries', 'bt709',
    '-color_trc', 'bt709',
    '-colorspace', 'bt709',
    '-movflags', '+faststart',
    diagnosticPath,
  ], `Encoding 4x seam diagnostic: ${diagnosticPath}`);

  process.stdout.write(`\nDone.\nMaster: ${masterPath}\nDiagnostic: ${diagnosticPath}\n`);
}

function smokeFrames() {
  const selected = new Set();
  for (let i = 0; i <= 8; i += 1) selected.add(i);
  for (let i = Math.round(25.5 * FPS); i <= Math.round(26.5 * FPS); i += 1) selected.add(i);
  return selected;
}

function captureAssertions(telemetry, hashes, firstDimensions) {
  const failures = [];
  const first = telemetry[0];
  const last = telemetry.at(-1);

  if (firstDimensions.width !== 2160 || firstDimensions.height !== 2700) {
    failures.push(`PNG dimensions are ${firstDimensions.width}x${firstDimensions.height}, expected 2160x2700.`);
  }
  if (!first.socialMode) failures.push('Social mode was not enabled for frame 0.');
  if (first.globalInCount !== 0) failures.push(`Frame 0 has ${first.globalInCount} revealed [data-s] nodes.`);
  if (first.openingVisibleCount !== 0) failures.push(`Frame 0 has ${first.openingVisibleCount} visible Opening nodes.`);
  if (Math.abs(first.worldX) > 0.25) failures.push(`Frame 0 world x is ${first.worldX}, expected 0.`);
  if (first.controlsDisplay !== 'none' || first.hintsDisplay !== 'none') failures.push('Capture UI is not display:none.');
  if (first.cursor !== 'none') failures.push(`Capture cursor is ${first.cursor}, expected none.`);
  if (first.creditText !== 'Concept, design and code by Takaaki Suzuki') failures.push('Credit text does not match Takaaki Suzuki.');

  const initialHashes = [...hashes.entries()]
    .filter(([frame]) => frame <= 4)
    .map(([, hash]) => hash);
  if (initialHashes.length === 5 && new Set(initialHashes).size !== 1) {
    failures.push('Raw PNG frames 0-4 are not identical; the Opening reset is not clean.');
  }

  const seam = telemetry.filter(row => row.timeSeconds >= 25.55 && row.timeSeconds <= 26.8);
  let maxPositiveWorldDelta = -Infinity;
  for (let i = 1; i < seam.length; i += 1) {
    maxPositiveWorldDelta = Math.max(maxPositiveWorldDelta, seam[i].worldX - seam[i - 1].worldX);
  }
  if (seam.length > 1 && maxPositiveWorldDelta > 0.25) {
    failures.push(`World reverses during the seam window by ${maxPositiveWorldDelta.toFixed(3)} CSS px.`);
  }

  const uiLeak = telemetry.find(row => row.controlsDisplay !== 'none' || row.hintsDisplay !== 'none' || row.cursor !== 'none');
  if (uiLeak) failures.push(`Capture UI/cursor leak at frame ${uiLeak.frame}.`);

  if (!smoke) {
    const finalHashes = [...hashes.entries()]
      .filter(([frame]) => frame >= FRAME_COUNT - 75)
      .map(([, hash]) => hash);
    const finalRows = telemetry.filter(row => row.frame >= FRAME_COUNT - 75);
    if (finalRows.length !== 75 || finalRows.some(row => !row.closingAllIn || row.closingMinOpacity < 0.999 || row.closingCtaOpacity < 0.999)) {
      failures.push('The completed Closing state is not held for all final 75 frames.');
    }
    if (!last.closingAllIn || last.closingMinOpacity < 0.999 || last.closingCtaOpacity < 0.999) {
      failures.push('Final Closing state is not fully revealed.');
    }
    if (last.creditOpacity < 0.999 || !last.creditInViewport) {
      failures.push('Final credit is not fully visible in the viewport.');
    }
  }

  return {
    passed: failures.length === 0,
    failures,
    pngDimensions: firstDimensions,
    openingFrames0To4Identical: initialHashes.length === 5 && new Set(initialHashes).size === 1,
    seamSamples: seam.length,
    maxPositiveWorldDelta: Number.isFinite(maxPositiveWorldDelta) ? maxPositiveWorldDelta : null,
    final75RawHashesIdentical: smoke ? null : [...hashes.entries()]
      .filter(([frame]) => frame >= FRAME_COUNT - 75)
      .map(([, hash]) => hash).every((value, _, all) => value === all[0]),
    earlyClosingCtaMs: EARLY_CLOSING_CTA_MS,
  };
}

async function main() {
  if (flags.has('--help') || flags.has('-h')) {
    process.stdout.write(`Usage: ./render-video.sh [options]\n\n` +
      `  --smoke         Render only Opening and 25.5-26.5 s diagnostic frames\n` +
      `  --clean         Remove the selected render directory before capture\n` +
      `  --render-only   Capture PNGs without encoding MP4 outputs\n` +
      `  --encode-only   Encode an existing complete render/frames sequence\n` +
      `  --resume        Allow capture into a directory that already has PNGs\n` +
      `  --render-dir=   Override the render artifact directory\n` +
      `  --output=       Override the master MP4 path\n` +
      `  --diagnostic=   Override the 4x seam MP4 path\n`);
    return;
  }
  if (!fs.existsSync(SOURCE_HTML)) throw new Error(`Missing ${SOURCE_HTML}`);
  if (encodeOnly) {
    const existingFrames = fs.existsSync(framesDir)
      ? (await fsp.readdir(framesDir)).filter(name => /^frame_\d{6}\.png$/.test(name))
      : [];
    if (existingFrames.length !== FRAME_COUNT) {
      throw new Error(`--encode-only requires ${FRAME_COUNT} PNGs in ${framesDir}; found ${existingFrames.length}.`);
    }
    const telemetry = (await fsp.readFile(telemetryPath, 'utf8'))
      .split('\n')
      .filter(Boolean)
      .map(line => JSON.parse(line));
    const hashes = new Map();
    for (let frame = 0; frame <= 4; frame += 1) {
      hashes.set(frame, sha256(await fsp.readFile(framePath(frame))));
    }
    for (let frame = FRAME_COUNT - 75; frame < FRAME_COUNT; frame += 1) {
      hashes.set(frame, sha256(await fsp.readFile(framePath(frame))));
    }
    const firstDimensions = pngDimensions(await fsp.readFile(framePath(0)));
    const captureQa = captureAssertions(telemetry, hashes, firstDimensions);
    await fsp.writeFile(captureQaPath, `${JSON.stringify(captureQa, null, 2)}\n`);
    if (!captureQa.passed) {
      throw new Error(`Capture QA failed:\n${captureQa.failures.map(item => `- ${item}`).join('\n')}`);
    }
    if (fs.existsSync(manifestPath)) {
      const manifest = JSON.parse(await fsp.readFile(manifestPath, 'utf8'));
      manifest.captureQa = captureQa;
      manifest.rendererSha256 = sha256(await fsp.readFile(__filename));
      await fsp.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    }
    await encodeOutputs();
    return;
  }
  if (clean) await fsp.rm(outputRoot, { recursive: true, force: true });
  await fsp.mkdir(framesDir, { recursive: true });

  const existingPngs = (await fsp.readdir(framesDir)).filter(name => name.endsWith('.png'));
  if (existingPngs.length && !flags.has('--resume')) {
    throw new Error(`${framesDir} already contains PNGs. Use --clean or --resume.`);
  }

  const { module: playwright, resolvedPath: playwrightPath } = loadPlaywright();
  const { chromium } = playwright;
  const executablePath = findChromium(chromium);
  const browser = await chromium.launch({
    executablePath,
    headless: true,
    args: [
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--hide-scrollbars',
    ],
  });

  const browserVersion = browser.version();
  const context = await browser.newContext({
    viewport: VIEWPORT,
    deviceScaleFactor: DEVICE_SCALE_FACTOR,
    reducedMotion: 'no-preference',
    colorScheme: 'light',
    locale: 'en-US',
    timezoneId: 'Asia/Tokyo',
  });
  const page = await context.newPage();
  page.on('console', message => {
    if (message.type() === 'error') process.stderr.write(`[browser console] ${message.text()}\n`);
  });
  page.on('pageerror', error => process.stderr.write(`[browser error] ${error.stack || error}\n`));

  await page.clock.install({ time: new Date('2026-07-11T00:00:00+09:00') });
  const sourceUrl = `${pathToFileURL(SOURCE_HTML).href}?social`;
  await page.goto(sourceUrl, { waitUntil: 'load' });
  await page.evaluate(() => document.fonts.ready);
  const currentWallTime = await page.evaluate(() => Date.now());
  await page.clock.pauseAt(currentWallTime);

  await page.addStyleTag({ content: `
    html, body, body * { cursor: none !important; }
    #controls, .controls, .kbd-hints {
      display: none !important;
      visibility: hidden !important;
      opacity: 0 !important;
      pointer-events: none !important;
    }
    body.capture-reset *, body.capture-reset *::before, body.capture-reset *::after {
      transition: none !important;
      animation: none !important;
    }
  ` });

  await page.evaluate(() => {
    document.body.classList.add('capture-reset');
    window.journey.social(true);
    window.journey.play();
    window.journey.goto(0);
    window.journey.pause();
    document.querySelectorAll('[data-s]').forEach(node => node.classList.remove('in'));
    document.body.classList.remove('ui');
    document.querySelector('#packet-card').classList.remove('travel', 'show');
    document.querySelector('#world').style.transform = 'translateX(0)';
    document.querySelectorAll('*').forEach(node => {
      if (getComputedStyle(node).cursor !== 'none') node.style.cursor = 'none';
    });
    for (const animation of document.getAnimations({ subtree: true })) animation.cancel();
    void document.documentElement.offsetWidth;
  });

  // Prime the private rAF timestamp while playback remains paused. This keeps
  // the first captured interval from inheriting pre-reset elapsed time.
  await page.clock.runFor(32);

  const captureInit = await page.evaluate(earlyClosingCtaMs => {
    for (const animation of document.getAnimations({ subtree: true })) animation.cancel();

    window.__captureClock = {
      animations: new Map(),
      sync(now) {
        const current = document.getAnimations({ subtree: true });
        const currentSet = new Set(current);
        for (const animation of this.animations.keys()) {
          if (!currentSet.has(animation)) this.animations.delete(animation);
        }
        let added = 0;
        for (const animation of current) {
          let meta = this.animations.get(animation);
          if (!meta) {
            animation.pause();
            animation.currentTime = 0;
            meta = { startedAt: now };
            this.animations.set(animation, meta);
            added += 1;
          }
          animation.currentTime = Math.max(0, now - meta.startedAt);
        }
        void document.documentElement.offsetWidth;
        return { activeAnimations: current.length, trackedAnimations: this.animations.size, added };
      },
    };

    document.body.classList.remove('capture-reset', 'ui');
    void document.documentElement.offsetWidth;
    window.journey.play();

    // The source's final CTA settles at 50.3 s, leaving only 2.1 s in a
    // 52.4 s master. Reveal it at 49.2 s in capture mode so the fully settled
    // Closing frame is held for at least 2.5 s without changing index.html.
    window.setTimeout(() => {
      document.querySelectorAll('#panel-closing [data-s="9"]').forEach(node => node.classList.add('in'));
    }, earlyClosingCtaMs);

    return window.__captureClock.sync(0);
  }, EARLY_CLOSING_CTA_MS);

  const selectedFrames = smoke ? smokeFrames() : null;
  const lastFrame = smoke ? Math.round(26.5 * FPS) : FRAME_COUNT - 1;
  const telemetry = [];
  const hashes = new Map();
  let closingFreezeBuffer = null;
  let firstDimensions = null;
  let elapsedMs = 0;
  const startedAt = Date.now();

  process.stdout.write(`Rendering ${smoke ? 'smoke selection' : `${FRAME_COUNT} frames`} with ${browserVersion}\n`);
  process.stdout.write(`CSS viewport ${VIEWPORT.width}x${VIEWPORT.height}, DPR ${DEVICE_SCALE_FACTOR}; PNG 2160x2700\n`);

  for (let frame = 0; frame <= lastFrame; frame += 1) {
    const targetMs = Math.round(frame * 1000 / FPS);
    while (elapsedMs < targetMs) {
      const nextMs = Math.min(targetMs, elapsedMs + CSS_TICK_MS);
      await page.clock.runFor(nextMs - elapsedMs);
      elapsedMs = nextMs;
      await page.evaluate(now => window.__captureClock.sync(now), elapsedMs);
    }

    if (selectedFrames && !selectedFrames.has(frame)) continue;

    const state = await page.evaluate(({ frame, targetMs }) => {
      const $ = selector => document.querySelector(selector);
      const opening = [...document.querySelectorAll('#panel-opening [data-s]')];
      const closing = [...document.querySelectorAll('#panel-closing [data-s]')];
      const credit = $('.credit-main');
      const creditRect = credit.getBoundingClientRect();
      const opacities = closing.map(node => Number.parseFloat(getComputedStyle(node).opacity));
      return {
        frame,
        timeSeconds: targetMs / 1000,
        scene: window.journey.scene(),
        worldX: Number($('#world').getBoundingClientRect().left.toFixed(4)),
        worldTransform: getComputedStyle($('#world')).transform,
        globalInCount: document.querySelectorAll('[data-s].in').length,
        openingVisibleCount: opening.filter(node => Number.parseFloat(getComputedStyle(node).opacity) > 0.0001).length,
        socialMode: document.body.classList.contains('social-mode'),
        controlsDisplay: getComputedStyle($('#controls')).display,
        hintsDisplay: getComputedStyle($('.kbd-hints')).display,
        cursor: getComputedStyle(document.body).cursor,
        creditText: credit.textContent.trim(),
        creditOpacity: Number.parseFloat(getComputedStyle(credit.closest('[data-s]')).opacity),
        creditInViewport: creditRect.left >= 0 && creditRect.right <= innerWidth && creditRect.top >= 0 && creditRect.bottom <= innerHeight,
        closingAllIn: closing.every(node => node.classList.contains('in')),
        closingMinOpacity: opacities.length ? Math.min(...opacities) : 0,
        closingCtaOpacity: Number.parseFloat(getComputedStyle($('#panel-closing [data-s="9"]')).opacity),
        captureAnimations: window.__captureClock.animations.size,
      };
    }, { frame, targetMs });

    const outputPath = framePath(frame);
    let buffer;
    if (!smoke && frame > FRAME_COUNT - 75 && closingFreezeBuffer) {
      buffer = closingFreezeBuffer;
      await fsp.writeFile(outputPath, buffer);
    } else {
      buffer = await page.screenshot({
        path: outputPath,
        type: 'png',
        scale: 'device',
        animations: 'allow',
        caret: 'hide',
      });
      if (!smoke && frame === FRAME_COUNT - 75) closingFreezeBuffer = buffer;
    }

    if (!firstDimensions) firstDimensions = pngDimensions(buffer);
    if (frame <= 4 || (!smoke && frame >= FRAME_COUNT - 75)) hashes.set(frame, sha256(buffer));
    telemetry.push(state);

    if (frame % 60 === 0 || frame === lastFrame) {
      const elapsed = (Date.now() - startedAt) / 1000;
      process.stdout.write(`frame ${frame + 1}/${lastFrame + 1} · t=${state.timeSeconds.toFixed(3)} s · ${elapsed.toFixed(1)} s wall\n`);
    }
  }

  await browser.close();
  await fsp.writeFile(telemetryPath, `${telemetry.map(row => JSON.stringify(row)).join('\n')}\n`);

  const captureQa = captureAssertions(telemetry, hashes, firstDimensions);
  await fsp.writeFile(captureQaPath, `${JSON.stringify(captureQa, null, 2)}\n`);

  const sourceBuffer = await fsp.readFile(SOURCE_HTML);
  const rendererBuffer = await fsp.readFile(__filename);
  const manifest = {
    createdAt: new Date().toISOString(),
    source: SOURCE_HTML,
    sourceSha256: sha256(sourceBuffer),
    renderer: __filename,
    rendererSha256: sha256(rendererBuffer),
    playwrightPath,
    chromiumExecutable: executablePath,
    chromiumVersion: browserVersion,
    fps: FPS,
    durationSeconds: DURATION_SECONDS,
    frameCount: FRAME_COUNT,
    viewport: VIEWPORT,
    deviceScaleFactor: DEVICE_SCALE_FACTOR,
    pngDimensions: firstDimensions,
    cssTickMs: CSS_TICK_MS,
    earlyClosingCtaMs: EARLY_CLOSING_CTA_MS,
    smoke,
    captureInit,
    captureQa,
  };
  await fsp.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  if (!captureQa.passed) {
    throw new Error(`Capture QA failed:\n${captureQa.failures.map(item => `- ${item}`).join('\n')}`);
  }

  process.stdout.write(`Capture QA passed. Telemetry: ${telemetryPath}\n`);
  if (renderOnly) return;

  await encodeOutputs();
}

main().catch(error => {
  process.stderr.write(`\n${error.stack || error}\n`);
  process.exitCode = 1;
});
