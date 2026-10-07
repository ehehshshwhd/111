FROM node:20-alpine

ENV NODE_ENV=production \
    PORT=8080 \
    SCORE_REVIEW_API_BASE=same-origin

WORKDIR /app

COPY score-review-web/package.json score-review-web/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

COPY score-review-web/server.js score-review-web/cloud-store.js score-review-web/index.html ./

EXPOSE 8080
CMD ["node", "server.js"]
