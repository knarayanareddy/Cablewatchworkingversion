FROM node:20-bookworm-slim

RUN apt-get update && apt-get install -y python3 procps && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .

ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

RUN chmod +x ./start.sh

EXPOSE 3000

ENV PORT=3000
ENV NODE_ENV=production

CMD ["./start.sh"]
