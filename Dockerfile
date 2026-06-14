# Dockerfile raíz para EasyPanel: buildea el panel de ClaUsina desde la raíz del repo.
FROM node:20-alpine
WORKDIR /app
COPY panel/package.json ./
RUN npm install --omit=dev
COPY panel/ ./
EXPOSE 3001
CMD ["node", "server.js"]
