FROM node:22-alpine AS web
WORKDIR /app/web
COPY web/package*.json ./
RUN npm install
COPY web/ ./
RUN npm run build

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY api/package*.json ./api/
RUN cd api && npm install --omit=dev
COPY api/ ./api/
COPY --from=web /app/web/dist ./web/dist
USER node
EXPOSE 8080
CMD ["node", "api/src/server.js"]
