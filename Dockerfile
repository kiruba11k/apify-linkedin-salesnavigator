# Use the official Apify Actor Node.js base image (includes Chrome + Playwright)
FROM apify/actor-node:20

# Copy package files first for better Docker layer caching
COPY package*.json ./

# Install production dependencies only
RUN npm install --omit=dev

# Copy source code
COPY . ./

# Start the Actor
CMD ["node", "src/main.js"]
