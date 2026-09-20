# 一条命令跑起来:
#   docker build -t myflowforge-relay . && docker run -p 8787:8787 myflowforge-relay
#
# ★镜像里没有任何配置、任何密钥、任何持久化。中转不该有状态 —— 它重启一次,
#  所有端各自重连就好了(daemon 会退避重连,客户端也会)。
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json ./
RUN npm install --omit=optional
COPY tsconfig.json ./
COPY src ./src
RUN npx tsc -p tsconfig.json

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json ./
RUN npm install --omit=dev --omit=optional && npm cache clean --force
COPY --from=build /app/dist ./dist
# ★非 root 跑。它是面向公网的进程,而且它**不需要**碰磁盘上的任何东西。
USER node
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:8787/healthz || exit 1
CMD ["node", "dist/main.js"]
