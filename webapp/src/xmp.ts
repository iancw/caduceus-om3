// The look in the photo: the camera writes the settings a shot was made with into the JPG's XMP packet as `cad:`
// attributes (docs/FORMATS.md "XMP fields (v1)"). This is the reference formatter (the firmware's output must match
// `cadText` byte for byte, docs/xmp-golden.json) and the reader the Control Panel uses to load a look from a photo.
// Field names, order, record offsets and ranges are read from docs/xmp-fields.json: there is no second table.
import fieldsJson from '../../docs/xmp-fields.json';
import { lookFromRecord } from './om3';
import type { Look } from './pack';

type Field = { name: string; kind: string; off?: number; min?: number; max?: number };
const FIELDS = fieldsJson.fields as Field[];
const NS = fieldsJson.namespace, PREFIX = fieldsJson.prefix, VERSION = fieldsJson.version;
const NAME_MAX = 15, FILMS = 20;
const XAP = 'http://ns.adobe.com/xap/1.0/\0';
const s8 = (b: number) => (b << 24) >> 24;

/** What the camera writes after the Rating digit: the namespace and one attribute per field (no trailing space). */
export function cadText(rec: Uint8Array, film: number, name: string): string {
  const clean = Array.from(name.slice(0, NAME_MAX), (ch) => (/[\x20-\x7e]/.test(ch) && !/[&<>"']/.test(ch) ? ch : '_')).join('');
  let out = ` xmlns:${PREFIX}="${NS}"`;
  for (const f of FIELDS) {
    let v: string;
    if (f.kind === 'version') v = String(VERSION);
    else if (f.kind === 'look') { if (!clean) continue; v = clean; }
    else if (f.kind === 'film') v = String(film);
    else if (f.kind === 'list12') v = Array.from({ length: 12 }, (_, i) => s8(rec[f.off! + i])).join(',');
    else v = String(s8(rec[f.off!]));
    out += ` ${PREFIX}:${f.name}="${v}"`;
  }
  return out;
}

/** The XMP packet of a JPEG (the APP1 segment that starts with the XAP header), or null. */
export function findXmp(file: Uint8Array): string | null {
  if (file.length < 4 || file[0] !== 0xff || file[1] !== 0xd8) return null;
  let i = 2;
  while (i + 4 <= file.length && file[i] === 0xff) {
    const marker = file[i + 1];
    if (marker === 0xda || marker === 0xd9) return null;
    const len = (file[i + 2] << 8) | file[i + 3], end = i + 2 + len;
    if (len < 2 || end > file.length) return null;
    if (marker === 0xe1 && len >= 2 + XAP.length && String.fromCharCode(...file.subarray(i + 4, i + 4 + XAP.length)) === XAP)
      return new TextDecoder('utf-8').decode(file.subarray(i + 4 + XAP.length, end));
    i = end;
  }
  return null;
}

const attr = (xml: string, name: string): string | null => {
  const m = new RegExp(`\\s${PREFIX}:${name}="([^"]*)"`).exec(xml);
  return m ? m[1] : null;
};
function whole(v: string, f: Field): number {
  if (!/^-?\d+$/.test(v.trim())) throw new Error(`The photo's ${PREFIX}:${f.name} is "${v}", not a whole number.`);
  const n = Number(v);
  if (n < f.min! || n > f.max!) throw new Error(`The photo's ${PREFIX}:${f.name} is ${n}, outside ${f.min}..${f.max}.`);
  return n;
}

/** The `cad:` fields of an XMP packet -> the 64-byte record, the film number and the name. Throws a plain message naming the field. */
export function readCad(xml: string): { rec: Uint8Array; film: number; name: string } {
  const rec = new Uint8Array(64);
  let film = 0, name = '';
  for (const f of FIELDS) {
    const v = attr(xml, f.name);
    if (v === null) {
      if (f.kind === 'look') continue;
      throw new Error(`The photo's ${PREFIX}:${f.name} is missing.`);
    }
    if (f.kind === 'version') { if (v !== String(VERSION)) throw new Error(`The photo's ${PREFIX}:Version is "${v}"; this reader knows version ${VERSION}.`); }
    else if (f.kind === 'look') name = v.slice(0, NAME_MAX);
    else if (f.kind === 'film') { film = whole(v, { name: 'Film', kind: 'num', min: 0, max: FILMS }); }
    else if (f.kind === 'list12') {
      const parts = v.split(',');
      if (parts.length !== 12) throw new Error(`The photo's ${PREFIX}:${f.name} needs 12 numbers, it has ${parts.length}.`);
      parts.forEach((p, i) => { rec[f.off! + i] = whole(p, f) & 0xff; });
    } else rec[f.off!] = whole(v, f) & 0xff;
  }
  return { rec, film, name };
}

/** A JPEG made by the patched camera -> its look and film number. Throws plain messages. */
export function lookFromPhoto(file: Uint8Array): { look: Look; film: number } {
  if (file.length < 4 || file[0] !== 0xff || file[1] !== 0xd8) throw new Error('This is not a JPEG photo.');
  const xml = findXmp(file);
  if (xml === null) throw new Error('There is no XMP in this photo (or the file is cut short).');
  if (!new RegExp(`\\s${PREFIX}:\\w+="`).test(xml)) throw new Error('This photo has no Caduceus look in it.');
  const { rec, film, name } = readCad(xml);
  return { look: lookFromRecord(rec, name || 'Look'), film };
}
