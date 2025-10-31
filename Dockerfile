FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json index.html ./
COPY src ./src
RUN npm install
RUN npm run build

FROM node:20-alpine
WORKDIR /app
COPY --from=builder /app/dist ./dist
COPY server ./server
WORKDIR /app/server
RUN npm install --production
EXPOSE 4000
ENV NODE_ENV=production
CMD ["node", "index.js"]
