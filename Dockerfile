FROM node:20-slim

ENV NODE_ENV=production
WORKDIR /app

# 先装依赖 (利用镜像层缓存)
COPY backend/package.json backend/package-lock.json ./backend/
RUN cd backend && npm ci --omit=dev

# 后端会读取 ../frontend/index.html 作为静态页
COPY backend/ ./backend/
COPY frontend/ ./frontend/

ENV PORT=4020
EXPOSE 4020

CMD ["node", "backend/server.js"]
