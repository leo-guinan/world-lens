FROM mcr.microsoft.com/playwright:v1.58.0-noble
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
COPY public ./public
RUN mkdir -p /data && chown -R pwuser:pwuser /app /data
USER pwuser
ENV PORT=8792 DATA_DIR=/data
EXPOSE 8792
CMD ["npm", "start"]
