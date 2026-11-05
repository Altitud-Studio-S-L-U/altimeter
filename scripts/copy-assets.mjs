import { cpSync } from 'node:fs';

// The analyst rubrics are read at run time, so the build copies them next to the compiled analysis code.
cpSync('src/ai/rubrics', 'dist/ai/rubrics', { recursive: true });
