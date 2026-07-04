import { createHash } from 'node:crypto';
import type { Board, Transport } from './types.js';

const strip = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

export function normalizeBoard(raw: string | null | undefined): Board {
  if (!raw) return 'unknown';
  const s = strip(raw);
  if (s.includes('all') && s.includes('inclusive')) return 'AI';
  if (s.includes('plna penze') || s === 'fb') return 'FB';
  if (s.includes('polopenze') || s === 'hb') return 'HB';
  if (s.includes('snidan') || s === 'bb') return 'BB';
  if (s.includes('bez strav')) return 'none';
  return 'unknown';
}

export function normalizeTransport(raw: string | null | undefined): Transport {
  if (!raw) return 'unknown';
  const s = strip(raw);
  if (s.includes('letec') || s.includes('flight')) return 'flight';
  if (s.includes('vlastni') || s.includes('own')) return 'own';
  if (s.includes('autobus') || s.includes('bus')) return 'bus';
  return 'unknown';
}

// Kanonické názvy zemí; klíč = stripped varianta/slug.
const COUNTRIES = ['Řecko','Turecko','Egypt','Španělsko','Kypr','Bulharsko','Chorvatsko','Itálie','Tunisko','Malta','Portugalsko','Albánie','Černá Hora','Maroko','Spojené arabské emiráty','Thajsko','Zanzibar','Kapverdy','Dominikánská republika','Mexiko','Kuba','Maledivy','Mauricius','Seychely','Srí Lanka','Indonésie','Vietnam','Madeira','Kanárské ostrovy','Slovinsko','Francie','Rakousko','Maďarsko','Slovensko','Česká republika','Gruzie','Jordánsko','Izrael','Omán','Katar'];
const COUNTRY_BY_KEY = new Map(COUNTRIES.map(c => [strip(c), c]));
COUNTRY_BY_KEY.set('sae', 'Spojené arabské emiráty');
COUNTRY_BY_KEY.set('emiraty', 'Spojené arabské emiráty');
COUNTRY_BY_KEY.set('cerna hora', 'Černá Hora');

export function normalizeCountry(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const first = raw.split(/[\/,–-]/)[0]?.trim() ?? '';
  if (!first) return null;
  const hit = COUNTRY_BY_KEY.get(strip(first));
  if (hit) return hit;
  // fallback: Title-case první token tak jak přišel
  return first;
}

export function parseCzk(raw: string | null | undefined): number | null {
  if (!raw) return null;
  const m = raw.replace(/[   ]/g, '').match(/(\d{3,})(?:Kč|CZK|$|[^\d])/);
  if (!m?.[1]) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export function parseCzDate(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const iso = raw.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return iso[0];
  const cz = raw.match(/(\d{1,2})\.\s?(\d{1,2})\.\s?(\d{4})/);
  if (!cz) return null;
  const [, d, mo, y] = cz;
  return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

export function offerKeyHash(parts: (string | number | null | undefined)[]): string {
  return createHash('sha1').update(parts.map(p => String(p ?? '')).join('|')).digest('hex').slice(0, 16);
}
