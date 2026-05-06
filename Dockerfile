FROM node:20-slim

WORKDIR /app

# Copy package.json only first (for caching)
COPY package.json ./

# Install dependencies fresh (no lockfile)
RUN npm install

# Copy source code
COPY . .

# Build frontend + backend
RUN npm run build:all

# Expose the port
EXPOSE 8080

# Initialize DB and start server
CMD ["sh", "-c", "npm run db:init && node dist/server.js"]
