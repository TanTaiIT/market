/* eslint-disable no-console */
import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

// Import side-effect: mỗi feature route gọi registry.registerPath lúc được load.
// Thiếu dòng này thì spec xuất ra rỗng.
import '../src/features'
import '../src/features/platform-admin/platform-admin.routes'
import { generateOpenApiDocument } from '../src/config/openapi'

const OUTPUT = resolve(process.cwd(), 'openapi.json')

/** Chỉ những method thực sự là operation — PathItemObject còn chứa `parameters`, `$ref`… */
const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'] as const

const doc = generateOpenApiDocument()

const operations = Object.entries(doc.paths ?? {}).flatMap(([path, item]) =>
  HTTP_METHODS.filter((method) => item[method]).map((method) => ({
    label: `${method.toUpperCase()} ${path}`,
    operationId: item[method]?.operationId,
  })),
)

// Codegen phía FE lấy operationId làm tên hàm. Thiếu một cái là FE rơi về tên suy từ path,
// nên đổi path sẽ đổi tên hàm ở mọi call-site — chặn tại đây thay vì để FE phát hiện sau.
const missing = operations.filter((op) => !op.operationId)
if (missing.length > 0) {
  console.error(`❌ ${missing.length}/${operations.length} operation thiếu operationId:`)
  for (const op of missing) console.error(`   - ${op.label}`)
  process.exit(1)
}

const duplicates = Object.entries(
  operations.reduce<Record<string, number>>((acc, op) => {
    const id = op.operationId as string
    acc[id] = (acc[id] ?? 0) + 1
    return acc
  }, {}),
).filter(([, count]) => count > 1)

if (duplicates.length > 0) {
  console.error('❌ operationId bị trùng (codegen sẽ ghi đè hàm của nhau):')
  for (const [id, count] of duplicates) console.error(`   - ${id} (${count}×)`)
  process.exit(1)
}

writeFileSync(OUTPUT, `${JSON.stringify(doc, null, 2)}\n`, 'utf8')

console.log(`✅ ${OUTPUT}`)
console.log(
  `   ${Object.keys(doc.paths ?? {}).length} paths · ${operations.length} operations · ` +
    `${Object.keys(doc.components?.schemas ?? {}).length} schemas`,
)
