FROM node:24-alpine AS base

# Typst typesets the booklets, see the README. The QA workflow installs the
# same release, keep the two in step.
FROM base AS typst
ARG TYPST_VERSION=0.15.1
ARG TYPST_SHA256=a6d077d0a95eed5a2eba715b2dae06be954f624ccbf85758a03f389ded33118c
RUN apk add --no-cache curl xz \
  && curl -fsSL -o /tmp/typst.tar.xz "https://github.com/typst/typst/releases/download/v${TYPST_VERSION}/typst-x86_64-unknown-linux-musl.tar.xz" \
  && echo "${TYPST_SHA256}  /tmp/typst.tar.xz" | sha256sum -c - \
  && tar -xJf /tmp/typst.tar.xz -C /tmp \
  && install -m 0755 /tmp/typst-x86_64-unknown-linux-musl/typst /usr/local/bin/typst \
  && typst --version

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
COPY --from=typst /usr/local/bin/typst /usr/local/bin/typst
# the booklet templates and fonts, read at runtime next to the compiled code
COPY templates /app/templates
CMD ["node", "--import", "./src/tracing.js", "src/index.js"]
