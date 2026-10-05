# Multi-stage build cho TypeScript. Node 20 khớp `engines` trong package.json, `.nvmrc` và CI —
# ba nơi từng lệch nhau (20/22/24), và lệch là "chạy được ở CI, chết ở image" (audit 7.5).
FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json tsconfig*.json ./
RUN npm ci
COPY src ./src
RUN npm run build

FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=builder /app/dist ./dist

# Không chạy bằng root: một lỗ trong dependency không được thành quyền root trong container.
RUN addgroup -S app && adduser -S app -G app
USER app

EXPOSE 5000
# `/health` kiểm DB THẬT (xem app.ts) — orchestrator restart được instance mất Mongo thay vì để nó
# nhận traffic mà không phục vụ được gì. `start-period` chờ connectDB + assert lúc boot.
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD wget -qO- http://127.0.0.1:5000/health || exit 1
CMD ["node", "dist/server.js"]
