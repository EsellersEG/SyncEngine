FROM node:20-slim

WORKDIR /app

# Copy package.json only first (for caching)
COPY package.json ./

# Install dependencies fresh (no lockfile)
RUN npm install

# Copy source code
COPY . .

# Accept VITE_ env vars at build time (Railway passes service variables as build args)
ARG OPENAI_API_KEY
ENV OPENAI_API_KEY=$OPENAI_API_KEY

# Build frontend + backend
RUN npm run build:all

# Expose the port
EXPOSE 8080

# Initialize DB and start server
CMD ["sh", "-c", "npm run db:init && node dist/server.js"]
