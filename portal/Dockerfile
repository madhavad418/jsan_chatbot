FROM node:22-alpine AS frontend
WORKDIR /app/frontend
COPY frontend/package*.json ./
RUN npm install
COPY frontend/ ./
RUN npm run build

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
# The database package is a file: dependency of the backend, so it has to be in
# place before npm install can resolve the link.
COPY database/ ./database/
COPY backend/package*.json ./backend/
RUN cd backend && npm install --omit=dev
COPY backend/ ./backend/
COPY --from=frontend /app/frontend/dist ./frontend/dist
USER node
EXPOSE 8080
CMD ["node", "backend/src/server.js"]
