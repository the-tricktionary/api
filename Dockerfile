FROM node:20-alpine as base

FROM base as runtime_deps
WORKDIR /src
COPY package.json .
COPY package-lock.json .
RUN npm ci --omit=dev

FROM runtime_deps as dev_deps
RUN npm ci

FROM dev_deps as builder
COPY codegen.yml tsconfig* ./
COPY src src
RUN npm run codegen
RUN npm run build

FROM base as runner
ARG GITHUB_SHA
ARG GITHUB_REF
ENV GITHUB_SHA=${GITHUB_SHA}
ENV GITHUB_REF=${GITHUB_REF}
WORKDIR /app
COPY --from=runtime_deps /src/node_modules /app/node_modules
COPY --from=builder /src/dist /app
CMD ["node", "src/index.js"]
