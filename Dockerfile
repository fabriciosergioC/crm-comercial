FROM node:22-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY backend ./backend
COPY frontend ./frontend
COPY api ./api

ENV NODE_ENV=production
ENV HOST=0.0.0.0

EXPOSE 3001

CMD ["npm", "start"]
