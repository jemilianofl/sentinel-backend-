# Etapa 1: Construcción
FROM node:22-slim AS builder

WORKDIR /app

# Copiar manifiestos de dependencias
COPY package*.json ./

# Instalar dependencias resolviendo paquetes opcionales nativos de Linux
RUN npm install --include=dev --ignore-scripts --no-audit --no-fund

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