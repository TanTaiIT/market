import { z } from 'zod'
import {
  OpenAPIRegistry,
  OpenApiGeneratorV3,
  extendZodWithOpenApi,
} from '@asteasolutions/zod-to-openapi'
import { env } from './env'

// Mở rộng zod với .openapi() — phải chạy MỘT LẦN trước khi bất kỳ schema nào dùng .openapi().
// Mọi schema/route feature import `registry` từ file này nên phần extend luôn chạy trước.
extendZodWithOpenApi(z)

export const registry = new OpenAPIRegistry()

// Đăng ký bearer auth để các route protected tham chiếu.
export const bearerAuth = registry.registerComponent('securitySchemes', 'bearerAuth', {
  type: 'http',
  scheme: 'bearer',
  bearerFormat: 'JWT',
})

/**
 * Sinh OpenAPI document từ toàn bộ schema/route đã register.
 * Gọi SAU khi tất cả feature modules đã được import (side-effect register).
 */
export function generateOpenApiDocument() {
  const generator = new OpenApiGeneratorV3(registry.definitions)
  return generator.generateDocument({
    openapi: '3.0.0',
    info: {
      title: 'Chợ Tốt Clone API',
      version: '1.0.0',
      description: 'Marketplace/Classifieds REST API (code-first OpenAPI từ Zod)',
    },
    servers: [{ url: env.API_PREFIX }],
  })
}
