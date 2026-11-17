import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { SentinelController } from './sentinel/sentinel.controller.js';
import { SentinelService } from './sentinel/sentinel.service.js';
import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';
import { GisModule } from './gis/gis.module.js';

@Module({
  imports: [HttpModule, GisModule],
  controllers: [AppController, SentinelController,],
  providers: [AppService, SentinelService],
})
export class AppModule {}