// Render every Mermaid diagram in its own clean page (per-figure config actually applies there),
// inject the SVGs into the design doc, size each to its box, then print the PDF.
// Usage: node render.mjs <input.html> <output.pdf> [imagesDir]  (imagesDir/so-do and imagesDir/trang are rebuilt)
import puppeteer from 'puppeteer-core'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const [, , input, output, shotsDir] = process.argv
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const MERMAID = resolve('node_modules/mermaid/dist/mermaid.min.js')
const BASE = JSON.parse(readFileSync('mermaid-config.json', 'utf8'))
// data-wrap="wide": vertical diagrams whose labels carry long lines; unset: Mermaid's default wrapping.
const WIDE_WRAP = 420

const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-first-run', '--allow-file-access-from-files'] })
try {
  const page = await browser.newPage()
  const pageErrors = []
  page.on('pageerror', (e) => pageErrors.push(String(e)))
  await page.setViewport({ width: 1400, height: 1000, deviceScaleFactor: 2 })
  await page.emulateMediaType('print')
  await page.goto(pathToFileURL(resolve(input)).href, { waitUntil: 'load' })

  const figs = await page.evaluate(() =>
    [...document.querySelectorAll('figure.fig[data-src]')].map((f) => ({
      id: f.id,
      wrap: f.dataset.wrap || '',
      src: document.getElementById(f.dataset.src).textContent.trim(),
    })),
  )

  const failures = []
  const worker = await browser.newPage()
  await worker.setViewport({ width: 1400, height: 1000 })
  for (const fig of figs) {
    await worker.goto('about:blank')
    await worker.addScriptTag({ path: MERMAID })
    const cfg = structuredClone(BASE)
    if (fig.wrap === 'wide') cfg.flowchart.wrappingWidth = WIDE_WRAP
    const result = await worker.evaluate(async (cfg, id, src) => {
      try {
        mermaid.initialize(cfg)
        const { svg } = await mermaid.render('mm-' + id, src)
        return { svg }
      } catch (e) {
        return { error: String((e && e.message) || e) }
      }
    }, cfg, fig.id, fig.src)
    if (result.error) {
      failures.push(`${fig.id}: ${result.error}`)
      continue
    }
    await page.evaluate((id, svg) => {
      const fig = document.getElementById(id)
      const canvas = fig.querySelector('.canvas')
      const W = canvas.clientWidth
      canvas.innerHTML = svg
      const el = canvas.querySelector('svg')
      const vb = (el.getAttribute('viewBox') || '').split(/[\s,]+/).map(Number)
      const [vw, vh] = [vb[2], vb[3]]
      const H = Number(fig.dataset.maxh || 600)
      const s = Math.min(W / vw, H / vh, Number(fig.dataset.maxscale || 1.15))
      el.setAttribute('width', Math.floor(vw * s))
      el.setAttribute('height', Math.floor(vh * s))
      el.style.maxWidth = 'none'
      fig.dataset.scale = s.toFixed(2)
      fig.dataset.natural = Math.round(vw) + 'x' + Math.round(vh)
    }, fig.id, result.svg)
  }
  await worker.close()
  if (failures.length) console.log('MERMAID ERRORS:\n' + failures.join('\n---\n'))
  if (pageErrors.length) console.log('PAGE ERRORS:\n' + pageErrors.join('\n'))

  // A4 landscape minus 11mm top/bottom margins = 188mm of printable height per page.
  const qa = await page.evaluate(() => {
    const mm = (px) => (px * 25.4) / 96
    const figs = [...document.querySelectorAll('figure.fig')].map((f) => {
      const svg = f.querySelector('svg')
      const s = Number(f.dataset.scale || 0)
      return `${f.id.padEnd(6)} scale=${f.dataset.scale ?? '-'}${s && s < 0.62 ? ' SMALL' : '      '} natural=${f.dataset.natural ?? '-'} size=${svg ? svg.getAttribute('width') + 'x' + svg.getAttribute('height') : 'none'}`
    })
    const pages = [...document.querySelectorAll('section.pg')].map((s, i) => {
      const h = s.getBoundingClientRect().height
      const title = (s.querySelector('h2, h1')?.textContent ?? '').slice(0, 48)
      return `p${String(i + 1).padStart(2, '0')} ${mm(h).toFixed(0).padStart(4)}mm ${mm(h) > 188 ? 'OVERFLOW' : 'ok      '} ${title}`
    })
    return { figs, pages }
  })
  console.log('--- figures ---\n' + qa.figs.join('\n'))
  console.log('--- pages (limit 188mm) ---\n' + qa.pages.join('\n'))

  // Only the two folders this script owns are cleared, never shotsDir itself.
  if (shotsDir) {
    const diagramsDir = `${shotsDir}/so-do`
    const pagesDir = `${shotsDir}/trang`
    for (const dir of [diagramsDir, pagesDir]) {
      rmSync(dir, { recursive: true, force: true })
      mkdirSync(dir, { recursive: true })
    }
    const els = await page.$$('figure.fig')
    for (const el of els) {
      const { name, svg } = await el.evaluate((n) => {
        const node = n.querySelector('svg')
        if (!node) return { name: n.dataset.name || n.id, svg: null }
        // Standalone SVG at natural size, not the page-fitted size.
        const clone = node.cloneNode(true)
        const vb = (clone.getAttribute('viewBox') || '').split(/[\s,]+/).map(Number)
        clone.setAttribute('width', String(Math.round(vb[2])))
        clone.setAttribute('height', String(Math.round(vb[3])))
        clone.style.maxWidth = ''
        clone.style.backgroundColor = '#ffffff'
        return { name: n.dataset.name || n.id, svg: clone.outerHTML }
      })
      await el.$eval('figcaption', (c) => (c.style.display = 'none')).catch(() => {})
      await el.screenshot({ path: `${diagramsDir}/${name}.png` })
      await el.$eval('figcaption', (c) => (c.style.display = '')).catch(() => {})
      if (svg) writeFileSync(`${diagramsDir}/${name}.svg`, svg)
    }
    const sections = await page.$$('section.pg')
    for (const [i, el] of sections.entries()) {
      await el.screenshot({ path: `${pagesDir}/trang-${String(i + 1).padStart(2, '0')}.png` })
    }
    console.log(`images: ${els.length} diagrams (png+svg), ${sections.length} pages`)
  }

  await page.pdf({ path: output, preferCSSPageSize: true, printBackground: true })
  console.log('pdf written:', output)
} finally {
  await browser.close()
}
