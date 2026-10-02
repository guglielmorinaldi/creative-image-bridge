FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json ./
RUN npm install --omit=dev
COPY src ./src
COPY data ./data
RUN mkdir -p /data/assets /data/outputs
ENV DATA_DIR=/data PORT=8787 HOST=0.0.0.0
EXPOSE 8787
CMD ["npm", "start"]
