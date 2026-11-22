# Runs LawLens on any Docker host (Render uses render.yaml instead and doesn't need this).
FROM node:22-slim

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY server ./server
COPY public ./public

# data/ holds the law search index — a cache downloaded on demand, so ephemeral disk is fine.
# Accounts live in MongoDB (MONGODB_URI secret), not here.
RUN mkdir -p data && chown -R node:node /app
USER node

ENV NODE_ENV=production \
    PORT=3000 \
    TRUST_PROXY=1
EXPOSE 3000
CMD ["node", "--disable-warning=ExperimentalWarning", "server/index.js"]
