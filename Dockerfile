FROM node:22-alpine AS build
WORKDIR /app
# tsconfig.build.json too: it is what `npm run build` points tsc at, and it is
# the file that excludes the tests and the fakes from dist.
COPY package.json package-lock.json tsconfig.json tsconfig.build.json ./
RUN npm ci
COPY src ./src
RUN npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
EXPOSE 3000
# exec form: node is PID 1 so SIGTERM reaches it on a rolling deploy, which is
# what lets the counter flush in `main.ts` run before the process goes away.
CMD ["node", "dist/main.js"]
