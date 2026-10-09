import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertCleanConfig } from './environment.mjs';
import { providerConfigurationReport } from './providers.mjs';
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
assertCleanConfig(repo);
// Metadata only. No requests, credential values, configuration values or URLs.
console.log(JSON.stringify(providerConfigurationReport(repo), null, 2));
