FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY lib ./lib
COPY server.mjs ./
COPY scripts/create-password-reset.mjs ./scripts/
COPY public ./public
ENV NODE_ENV=production
EXPOSE 8788
CMD ["node", "server.mjs"]
