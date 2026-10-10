import { build } from 'esbuild';
await build({ entryPoints: ['web/mcp-client.src.js'], outfile: 'web/mcp-client.js', bundle: true, minify: true, format: 'iife', target: 'es2022', legalComments: 'eof' });
