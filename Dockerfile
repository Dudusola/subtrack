FROM node:22-alpine
WORKDIR /app
COPY package.json server.js detect.js gmail.js ./
COPY public ./public
ENV NODE_ENV=production DATABASE_PATH=/data/subtrack.db PORT=3000
VOLUME /data
EXPOSE 3000
USER node
CMD ["node", "server.js"]
