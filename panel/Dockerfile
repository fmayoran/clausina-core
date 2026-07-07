FROM node:20-alpine
WORKDIR /app
# ffmpeg: comprime videos subidos a la biblioteca a calidad apta para Instagram.
RUN apk add --no-cache ffmpeg
COPY package.json ./
RUN npm install --omit=dev
COPY . .
EXPOSE 3001
CMD ["node", "server.js"]
