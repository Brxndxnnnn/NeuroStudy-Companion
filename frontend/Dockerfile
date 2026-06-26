# --- Stage 1: Install Dependencies ---
FROM node:20-alpine AS deps
WORKDIR /app
# Copy package manifests
COPY package.json package-lock.json ./
# Tell npm to retry up to 5 times if the network drops, then install
RUN npm config set fetch-retries 5 && npm install

# --- Stage 2: Build the App ---
FROM node:20-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
# Copy all project files
COPY . .
# Build the Next.js app
RUN npm run build

# --- Stage 3: Production Runner ---
FROM node:20-alpine AS runner
WORKDIR /app

# Using the modern ENV syntax to clear Docker warnings
ENV NODE_ENV=production
ENV PORT=3000

# Copy the standalone build from the builder stage
COPY --from=builder /app/public ./public
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static

EXPOSE 3000

# Start the standalone server
CMD ["node", "server.js"]