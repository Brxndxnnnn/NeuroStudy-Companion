# --- Stage 1: Install Dependencies
FROM node:18-alpine AS deps
WORKDIR /app
# Copy package manifests
COPY package.json package-lock.json ./
# Install dependencies cleanly
RUN npm ci

# --- Stage 2: Build the App
FROM node:18-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
# Copy all project files
COPY . .
# Build the Next.js app
RUN npm run build

# --- Stage 3: Production Runner ---
FROM node:18-alpine AS runner
WORKDIR /app

ENV NODE_ENV production
ENV PORT 3000

# Copy the standalone build from the builder stage
COPY --from=builder /app/public ./public
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static

EXPOSE 3000

# Start the standalone server
CMD ["node", "server.js"]