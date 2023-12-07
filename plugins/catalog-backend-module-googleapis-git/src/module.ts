import { coreServices, createBackendModule } from '@backstage/backend-plugin-api';

export const catalogModuleGoogleapisGit = createBackendModule({
  pluginId: 'catalog',
  moduleId: 'googleapis-git',
  register(reg) {
    reg.registerInit({
      deps: { logger: coreServices.logger },
      async init({ logger }) {
        logger.info('Hello World!')
      },
    });
  },
});
