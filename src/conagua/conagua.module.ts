// src/conagua/conagua.module.ts
import { Module } from '@nestjs/common';
import { ConaguaController } from './conagua.controller.js';
import { ConaguaService } from './conagua.service.js';

@Module({
  controllers: [ConaguaController],
  providers: [ConaguaService],
  exports: [ConaguaService] // Opcional, por si otro módulo lo necesita
})
export class ConaguaModule {}