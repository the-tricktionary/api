FROM node:24-alpine AS base

FROM base AS runtime_deps
WORKDIR /src
COPY package.json .
COPY package-lock.json .
RUN npm ci --omit=dev

FROM runtime_deps AS dev_deps
RUN npm ci

FROM dev_deps AS builder
COPY codegen.yml tsconfig* ./
COPY src src
RUN npm run codegen
RUN npm run build

FROM base AS runner
ARG GITHUB_SHA
ARG GITHUB_REF
ENV GITHUB_SHA=${GITHUB_SHA}
ENV GITHUB_REF=${GITHUB_REF}
WORKDIR /app
COPY --from=runtime_deps /src/node_modules /app/node_modules
# the package is ESM, and node decides that from the nearest package.json
COPY --from=runtime_deps /src/package.json /app/package.json
COPY --from=builder /src/dist /app
CMD ["node", "--import", "./src/tracing.js", "src/index.js"]
