# Etapa 1: Construcción
FROM node:22-slim AS builder

WORKDIR /app

# Copiar manifiestos de dependencias
COPY package*.json ./

# Instalar todas las dependencias (incluyendo devDependencies para nest build)
# y omitir scripts de husky/git que fallan dentro del contenedor
RUN npm ci --include=dev --ignore-scripts

# Copiar código fuente y compilar
COPY . .
RUN npm run build

# Dejar solo dependencias de producción
RUN npm prune --omit=dev --ignore-scripts

# Etapa 2: Ejecución ligera en producción
FROM node:22-slim AS runner

WORKDIR /app
ENV NODE_ENV=production

COPY --from=builder /app/package*.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist

EXPOSE 3000

CMD ["npm", "run", "start:prod"]