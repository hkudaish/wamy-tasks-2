FROM node:20-alpine
# عميل PostgreSQL حديث لضمان توافق النسخ الاحتياطية مع الخادم
RUN apk add --no-cache postgresql17-client tini
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
RUN mkdir -p /app/uploads && addgroup -S app && adduser -S app -G app && chown -R app:app /app
USER app
EXPOSE 3000
ENV NODE_ENV=production
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["/sbin/tini","--"]
CMD ["node","server/index.js"]
