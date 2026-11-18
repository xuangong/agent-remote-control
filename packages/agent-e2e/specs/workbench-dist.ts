import { fileURLToPath } from 'node:url';

/** The built Workbench, which the specs that start their own Gateway serve. */
export const WORKBENCH_DIST = fileURLToPath(new URL('../../agent-remote-lab/dist', import.meta.url));
