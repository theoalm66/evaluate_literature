# Publikations-Agent: App + Spark-Backend (Node 22, SQLite eingebaut – keine nativen Pakete nötig)
FROM node:22-bookworm-slim
WORKDIR /srv/lit
ENV NODE_ENV=production LIT_HOST=0.0.0.0 LIT_PORT=8080 LIT_DB=/data/lit.db
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY server ./server
COPY app ./app
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 8080
CMD ["node", "--disable-warning=ExperimentalWarning", "server/index.js"]
