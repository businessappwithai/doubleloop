FROM node:22-alpine AS base

RUN corepack enable && corepack prepare pnpm@9 --activate

# Build stage
FROM base AS builder
WORKDIR /app

COPY dlo/pnpm-workspace.yaml dlo/pnpm-lock.yaml dlo/package.json ./
COPY dlo/packages/copilotkit-ui/package.json ./packages/copilotkit-ui/
COPY dlo/packages/core/package.json ./packages/core/
COPY dlo/packages/adapters-pi/package.json ./packages/adapters-pi/

RUN pnpm install --frozen-lockfile

COPY dlo/packages ./packages

WORKDIR /app/packages/copilotkit-ui

RUN NEXT_OUTPUT=standalone pnpm build

# Production stage
FROM base AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=8090

RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 nextjs

COPY --from=builder /app/packages/copilotkit-ui/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/packages/copilotkit-ui/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/packages/copilotkit-ui/.next/static ./.next/static

RUN mkdir -p /app/.dlo/pipelines && chown -R nextjs:nodejs /app/.dlo

USER nextjs
EXPOSE 8090

CMD ["node", "server.js"]
