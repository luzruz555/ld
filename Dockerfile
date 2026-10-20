FROM node:22-slim

# 한글 폰트 (대사/이름표 렌더링용)
RUN apt-get update \
 && apt-get install -y --no-install-recommends fontconfig fonts-noto-cjk \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY server.js ./
COPY bg ./bg
COPY char ./char

ENV PORT=8080
EXPOSE 8080
CMD ["node", "server.js"]
