FROM node:20-slim

WORKDIR /app

COPY package*.json ./
RUN npm ci --production

COPY . .
RUN mkdir -p /app/data

EXPOSE 7100

CMD ["node", "src/daemon.mjs"]
