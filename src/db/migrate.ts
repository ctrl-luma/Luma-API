import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { query } from './index';
import { logger } from '../utils/logger';

export async function runMigrations() {
  try {
    // Create migrations table if it doesn't exist
    await query(`
      CREATE TABLE IF NOT EXISTS migrations (
        id SERIAL PRIMARY KEY,
        filename VARCHAR(255) UNIQUE NOT NULL,
        executed_at TIMESTAMP DEFAULT NOW()
      )
    `);

    // Get list of migration files
    const migrationsDir = join(__dirname, '../../db/migrations');
    const migrationFiles = readdirSync(migrationsDir)
      .filter(file => file.endsWith('.sql'))
      .sort(); // Ensure they run in order

    for (const file of migrationFiles) {
      // Check if migration has already been run
      const result = await query(
        'SELECT id FROM migrations WHERE filename = $1',
        [file]
      );

      if (result.length === 0) {
        logger.info(`Running migration: ${file}`);
        
        // Read and execute migration
        const sql = readFileSync(join(migrationsDir, file), 'utf8');
        await query(sql);
        
        // Record migration as completed
        await query(
          'INSERT INTO migrations (filename) VALUES ($1)',
          [file]
        );
        
        logger.info(`Migration completed: ${file}`);
      } else {
        logger.info(`Migration already executed: ${file}`);
      }
    }

    logger.info('All migrations completed successfully');
  } catch (error) {
    logger.error('Migration failed:', error);
    throw error;
  }
}

// Run init.sql if tables don't exist
export async function initializeDatabase() {
  try {
    // Check if users table exists (as a proxy for whether DB is initialized)
    const result = await query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables 
        WHERE table_schema = 'public' 
        AND table_name = 'users'
      );
    `);

    if (!result[0].exists) {
      logger.info('Database not initialized, running init.sql...');
      const initSql = readFileSync(join(__dirname, '../../db/init.sql'), 'utf8');
      await query(initSql);
      logger.info('Database initialized successfully');
    }

    // Run migrations after ensuring base schema exists
    await runMigrations();
  } catch (error) {
    logger.error('Database initialization failed:', error);
    throw error;
  }
}