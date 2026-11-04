FROM node:22.16.0-bookworm-slim
WORKDIR /app
COPY --chown=1005:100 server.mjs integrations.mjs dashboard.mjs preferences.mjs recordstudio.mjs ./
COPY --chown=1005:100 public ./public
COPY --chown=1005:100 scripts ./scripts
RUN mkdir -p /app/metrics /app/data && chown -R 1005:100 /app
USER 1005:100
# Fail the build if any imported backend module was omitted from the image.
RUN node --check server.mjs && NODE_ENV=test node --input-type=module -e "await import('./server.mjs'); console.log('Backend module imports OK')"
ENV PORT=3000 METRICS_DIR=/app/metrics DATA_DIR=/app/data NODE_ENV=production
EXPOSE 3000
HEALTHCHECK --interval=60s --timeout=8s --start-period=15s --retries=3 CMD node -e "fetch('http://127.0.0.1:3000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node","server.mjs"]
