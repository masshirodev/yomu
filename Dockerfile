FROM node:24-bookworm-slim AS base
WORKDIR /app
RUN corepack enable

FROM base AS dependencies
COPY package.json yarn.lock ./
# better-sqlite3 is a native addon; the slim image has no toolchain to build it
# from source if a prebuilt binary is unavailable for this platform.
RUN apt-get update \
	&& apt-get install -y --no-install-recommends python3 make g++ \
	&& yarn install --frozen-lockfile \
	&& rm -rf /var/lib/apt/lists/*

FROM dependencies AS build
COPY . .
# The kuromoji dictionary lives in node_modules and is gitignored, so it has to
# be copied into static/ before the build sweeps static/ into the client bundle.
RUN yarn sync:dict && yarn build

FROM base AS production-dependencies
COPY package.json yarn.lock ./
RUN apt-get update \
	&& apt-get install -y --no-install-recommends python3 make g++ \
	&& yarn install --frozen-lockfile --production=true \
	&& rm -rf /var/lib/apt/lists/*

FROM node:24-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000 YOMU_DB=/app/data/yomu.db
COPY --from=production-dependencies /app/node_modules ./node_modules
COPY --from=build /app/build ./build
COPY package.json ./
# The line store is the only writeable path; everything else stays read-only.
RUN mkdir -p /app/data && chown node:node /app/data
USER node
EXPOSE 3000
CMD ["node", "build"]
