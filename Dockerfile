# Runs LawLens on any Docker host. Hugging Face Spaces (free CPU tier) expects port 7860 and uid 1000.
FROM node:22-slim

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY server ./server
COPY public ./public

# data/ holds the law search index — a cache rebuilt on demand, so ephemeral disk is fine.
# Accounts live in MongoDB (MONGODB_URI secret), not here.
RUN mkdir -p data && chown -R node:node /app
USER node

ENV NODE_ENV=production \
    PORT=7860 \
    TRUST_PROXY=1
EXPOSE 7860
CMD ["node", "--disable-warning=ExperimentalWarning", "server/index.js"]
