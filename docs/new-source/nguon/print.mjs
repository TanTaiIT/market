// In một trang HTML tĩnh (không có lược đồ Mermaid) ra PDF bằng Chrome đã cài trên máy.
// Dùng: node print.mjs <input.html> <output.pdf>
import puppeteer from 'puppeteer-core'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const [, , input, output] = process.argv
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe'

const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-first-run'] })
try {
  const page = await browser.newPage()
  await page.emulateMediaType('print')
  await page.goto(pathToFileURL(resolve(input)).href, { waitUntil: 'load' })
  await page.pdf({ path: output, preferCSSPageSize: true, printBackground: true })
  console.log('pdf written:', output)
} finally {
  await browser.close()
}
