import { dailyGenerationService } from '../services/daily-generation.service.js';
import { logger } from '../utils/logger.js';

const DEFAULT_COUNT_PER_MEAL = 2;

async function run(): Promise<void> {
  await dailyGenerationService.generateSharedForAllUsers({
    countPerMeal: DEFAULT_COUNT_PER_MEAL,
    triggerSource: 'scheduled',
  });
}

run()
  .then(() => {
    logger.info('Scheduled daily generation complete');
    process.exit(0);
  })
  .catch((err) => {
    logger.error({ err }, 'Scheduled daily generation failed');
    process.exit(1);
  });
