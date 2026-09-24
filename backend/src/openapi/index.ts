import { OpenAPIRegistry, OpenApiGeneratorV3 } from '@asteasolutions/zod-to-openapi';

import { name, version } from '../../package.json';

const registry = new OpenAPIRegistry();

registry.registerComponent('securitySchemes', 'bearerAuth', {
  type: 'http',
  scheme: 'bearer',
  bearerFormat: 'JWT',
});

// NOTE: per-module OpenAPI path registration (auth/team/clients/platform/me) is not
// wired up yet - this phase focused on the working API surface. Swagger UI will load
// with the security scheme defined but no documented paths. Follow-up work.

const generator = new OpenApiGeneratorV3(registry.definitions);

export const openApiDocument = generator.generateDocument({
  openapi: '3.0.0',
  info: {
    title: `${name} API documentation`,
    version,
  },
  servers: [
    {
      url: '/v1',
    },
  ],
  security: [{ bearerAuth: [] }],
});
