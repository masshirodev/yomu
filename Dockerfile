# Build with kotoba, the Japanese lookup yomu shares with tsundoku, as a named
# context beside this one (package.json has "kotoba": "link:../kotoba"):
#
#   docker build --build-context kotoba=../kotoba -t yomu .
#
# It lands at /kotoba, so /app's link:../kotoba finds it where it does on disk.
FROM node:24-bookworm-slim AS base
WORKDIR /app
RUN corepack enable

FROM base AS with-kotoba
COPY --from=kotoba package.json yarn.lock /kotoba/
COPY --from=kotoba src /kotoba/src
COPY --from=kotoba scripts /kotoba/scripts

FROM with-kotoba AS dependencies
COPY package.json yarn.lock ./
# better-sqlite3 is a native addon; the slim image has no toolchain to build it
# from source if a prebuilt binary is unavailable for this platform. kotoba has
# its own node_modules (kuromoji, better-sqlite3), as it does on disk.
RUN apt-get update \
	&& apt-get install -y --no-install-recommends python3 make g++ \
	&& (cd /kotoba && yarn install --frozen-lockfile) \
	&& yarn install --frozen-lockfile \
	&& rm -rf /var/lib/apt/lists/*

FROM dependencies AS build
COPY . .
# The kuromoji dictionary lives in kotoba's node_modules and is gitignored, so it
# has to be copied into static/ before the build sweeps static/ into the client
# bundle.
RUN yarn sync:dict && yarn build

# JMdict, downloaded and flattened into SQLite at build time so the image is
# self-contained and a deploy cannot leave the reader without definitions.
# Baked into the image rather than the data volume: it is derived, identical for
# every deploy, and rebuilding it is how it gets updated.
#
# Built from `dependencies` rather than `build`, and copying only the one script
# it needs, so editing application source does not invalidate this layer. It
# downloads 12MB and indexes 218k entries; paying that on every deploy would
# make the build cost track the wrong thing entirely.
FROM dependencies AS dictionary
RUN node --max-old-space-size=2048 /kotoba/scripts/build-dict.js --out /app/jmdict.db

FROM with-kotoba AS production-dependencies
COPY package.json yarn.lock ./
RUN apt-get update \
	&& apt-get install -y --no-install-recommends python3 make g++ \
	&& (cd /kotoba && yarn install --frozen-lockfile --production=true) \
	&& yarn install --frozen-lockfile --production=true \
	&& rm -rf /var/lib/apt/lists/*

FROM node:24-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000 \
	YOMU_DB=/app/data/yomu.db \
	YOMU_JMDICT=/app/jmdict.db
COPY --from=production-dependencies /kotoba /kotoba
COPY --from=production-dependencies /app/node_modules ./node_modules
COPY --from=build /app/build ./build
COPY --from=dictionary /app/jmdict.db ./jmdict.db
COPY package.json ./
# The line store is the only writeable path; everything else stays read-only.
RUN mkdir -p /app/data && chown node:node /app/data
USER node
EXPOSE 3000
CMD ["node", "build"]
