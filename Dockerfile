FROM node:24-alpine AS build
WORKDIR /app
# tsconfig.build.json too: it is what `npm run build` points tsc at, and it is
# the file that excludes the tests and the fakes from dist.
COPY package.json package-lock.json tsconfig.json tsconfig.build.json ./
RUN npm ci
COPY src ./src
RUN npm run build

FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
EXPOSE 3000
# The image ships with an unprivileged `node` user and nothing here needs more
# than that: the server binds 3000, reads its config from the environment, and
# writes only to S3. Everything above is owned by root and stays read-only to
# this user, which is the point — a process that cannot rewrite its own code is
# one less thing an RCE buys.
USER node
# exec form: node is PID 1 so SIGTERM reaches it on a rolling deploy, which is
# what lets the counter flush in `main.ts` run before the process goes away.
CMD ["node", "dist/main.js"]
