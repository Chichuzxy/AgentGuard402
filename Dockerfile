FROM node:20-slim

ENV NODE_ENV=production
WORKDIR /app

# 先装依赖 (利用镜像层缓存)
COPY backend/package.json backend/package-lock.json ./backend/
RUN cd backend && npm ci --omit=dev

# 后端会读取 ../frontend/index.html 作为静态页
COPY backend/ ./backend/
COPY frontend/ ./frontend/

# 端口: 云平台会注入 PORT 环境变量; 没注入时 server.js 自己回落到 4020
EXPOSE 4020

CMD ["node", "backend/server.js"]
