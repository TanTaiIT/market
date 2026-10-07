// Assemble the design HTML: start from v1, then overlay each layer dir in order (v2, v3, ...).
// A layer file <key>.html replaces the section with that marker key; a key with no match is appended before </body>.
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs'
const SRC = 'thiet-ke-he-thong-moi.v1.html', OUT = 'thiet-ke-he-thong-moi.html'
const LAYERS = process.argv.slice(2).length ? process.argv.slice(2) : ['v2', 'v3']
let html = readFileSync(SRC, 'utf8')
const markerRe = /<!-- =+ ([A-Z0-9]+)[^>]*-->/g
const bounds = (key) => {
  const marks = [...html.matchAll(markerRe)]
  const i = marks.findIndex((m) => m[1] === key)
  if (i < 0) return null
  return [marks[i].index, i + 1 < marks.length ? marks[i + 1].index : html.indexOf('</body>')]
}
for (const dir of LAYERS) {
  if (!existsSync(dir)) continue
  const files = readdirSync(dir).filter((f) => f.endsWith('.html')).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
  for (const f of files) {
    const key = f.replace('.html', '')
    const sec = readFileSync(`${dir}/${f}`, 'utf8').replace(/\s+$/, '') + '\n\n'
    const b = bounds(key)
    if (b) html = html.slice(0, b[0]) + sec + html.slice(b[1])
    else html = html.replace('</body>', sec + '</body>')
  }
  console.log(dir, 'applied', files.length, 'sections')
}
writeFileSync(OUT, html)
console.log('sections now:', [...html.matchAll(markerRe)].map((m) => m[1]).join(' '))
