import { CatalogBuilder } from '@backstage/plugin-catalog-backend';
import { ScaffolderEntitiesProcessor } from '@backstage/plugin-catalog-backend-module-scaffolder-entity-model';
import { Router } from 'express';
import { PluginEnvironment } from '../types';
import { GoogleapisProvider } from '../../../../plugins/catalog-backend-module-googleapis-git/src/googleapis-provider';

export default async function createPlugin(
  env: PluginEnvironment,
): Promise<Router> {
  const builder = CatalogBuilder.create(env);
  const googleapisProvider = new GoogleapisProvider("production");
  builder.addEntityProvider(googleapisProvider);
  builder.addProcessor(new ScaffolderEntitiesProcessor());
  const { processingEngine, router } = await builder.build();
  await processingEngine.start();
  googleapisProvider.run();
  return router;
}
