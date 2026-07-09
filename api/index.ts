import { handle } from 'hono/vercel';
import { createApi } from '../src/web/api.js';
import { bootstrap } from './_lib/bootstrap.js';

const { db, cfg } = await bootstrap();
export default handle(createApi({ db, profiles: cfg.profiles }));
