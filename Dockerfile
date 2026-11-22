FROM node:24-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY dist/ ./dist/
COPY server/ ./server/
COPY database/ ./database/
COPY scripts/prepare-hosted.mjs ./scripts/prepare-hosted.mjs
USER node
CMD ["sh", "-c", "node scripts/prepare-hosted.mjs && exec node server/index.mjs"]
