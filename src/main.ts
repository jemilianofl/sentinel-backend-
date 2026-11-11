import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.enableCors(); // Permite peticiones desde localhost:5173 (React)
  await app.listen(process.env.PORT ?? 3000);
}
bootstrap();