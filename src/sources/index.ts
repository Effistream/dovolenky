import type { SourceAdapter } from '../core/types.js';
import { cedok } from './cedok.js';
import { bluestyle } from './bluestyle.js';
import { skrz } from './skrz.js';
import { zajezdy } from './zajezdy.js';
import { invia } from './invia.js';
import { etravel } from './etravel.js';
import { fischer } from './fischer.js';
import { eximtours } from './eximtours.js';
import { dovolena } from './dovolena.js';
import { dovolenkovani } from './dovolenkovani.js';
import { firo } from './firo.js';
import { alexandria } from './alexandria.js';
import { deluxea } from './deluxea.js';
import { esotravel } from './esotravel.js';
import { adventura } from './adventura.js';

/** All production source adapters, in scan order. */
export const adapters: SourceAdapter[] = [
  cedok,
  bluestyle,
  skrz,
  zajezdy,
  invia,
  etravel,
  fischer,
  eximtours,
  dovolena,
  dovolenkovani,
  firo,
  alexandria,
  deluxea,
  esotravel,
  adventura,
];
