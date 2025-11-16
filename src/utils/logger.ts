import winston from 'winston';
import { config } from '../config';

const format = winston.format.combine(
  winston.format.timestamp(),
  winston.format.errors({ stack: true }),
  winston.format.splat(),
  winston.format.json(),
  winston.format.prettyPrint({ colorize: config.env === 'development' })
);

export const logger = winston.createLogger({
  level: config.logging.level,
  format,
  defaultMeta: { service: 'luma-api' },
  transports: [
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.simple()
      ),
    }),
  ],
});

if (config.env === 'production') {
  logger.add(new winston.transports.File({ filename: 'error.log', level: 'error' }));
  logger.add(new winston.transports.File({ filename: 'combined.log' }));
}