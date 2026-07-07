// Bootstrap module loaded via --import in worker threads to register tsx's
// synchronous ESM hooks before the worker's TypeScript entry file is loaded.
// Required because tsx's async --import hooks do not remap .js → .ts in workers.
import { register } from 'tsx/esm/api';
register();
