import { z, ZodTypeAny } from 'zod'
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

export const errorResponseSchema = z
  .object({
    success: z.literal(false),
    message: z.string(),
    details: z.array(z.object({ path: z.string(), message: z.string() })).optional(),
  })
  .openapi('ErrorResponse')

registry.register('ErrorResponse', errorResponseSchema)

/** Mọi response thành công đều đi qua apiResponse.ts nên có chung vỏ này. */
export function envelope(data: ZodTypeAny, meta?: ZodTypeAny) {
  return z.object({
    success: z.literal(true),
    message: z.string(),
    data,
    ...(meta ? { meta } : {}),
  })
}

export function jsonResponse(description: string, schema: ZodTypeAny) {
  return { description, content: { 'application/json': { schema } } }
}

/** Response lỗi dùng lại ở gần như mọi endpoint — khai báo một chỗ. */
export function errorResponse(description: string) {
  return jsonResponse(description, errorResponseSchema)
}

export const paginationMetaSchema = z.object({
  page: z.number(),
  limit: z.number(),
  total: z.number(),
  totalPages: z.number(),
  hasNextPage: z.boolean(),
  hasPrevPage: z.boolean(),
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
