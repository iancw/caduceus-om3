// The look in the photo (docs/superpowers/specs/2026-11-10-look-in-photo-xmp-design.md): the reference formatter and the
// reader. Field names, order and ranges come from docs/xmp-fields.json; exact text from docs/xmp-golden.json.
import { describe, expect, it } from 'vitest';
import fields from '../../docs/xmp-fields.json';
import golden from '../../docs/xmp-golden.json';
import { cadText, findXmp, lookFromPhoto, readCad } from '../src/xmp';

const unhex = (h: string) => Uint8Array.from(Buffer.from(h, 'hex'));
const HDR = 'http://ns.adobe.com/xap/1.0/\0';

/** A packet shaped like the camera's: 2301 bytes, Rating, our text before "/>", blank padding, end marker. */
function packet(text: string): Buffer {
  const head = '<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>\n<x:xmpmeta xmlns:x="adobe:ns:meta/">\n'
    + ' <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">\n  <rdf:Description rdf:about=""\n'
    + '   xmlns:xmp="http://ns.adobe.com/xap/1.0/" xmp:Rating="0"' + text + '/>\n </rdf:RDF>\n</x:xmpmeta>\n';
  const end = '<?xpacket end="w"?>';
  const h = Buffer.from(head, 'utf8');
  return Buffer.concat([h, Buffer.alloc(2301 - h.length - end.length, 0x20), Buffer.from(end)]);
}
/** FF D8, an Exif-like APP1 first, then the XMP APP1, then FF D9. */
function jpeg(pkt: Buffer | null): Uint8Array {
  const seg = (payload: Buffer) => Buffer.concat([Buffer.from([0xff, 0xe1, (payload.length + 2) >> 8, (payload.length + 2) & 255]), payload]);
  const parts = [Buffer.from([0xff, 0xd8]), seg(Buffer.from('Exif\0\0MM\0*\0\0\0\b\0\0\0\0\0\0', 'latin1'))];
  if (pkt) parts.push(seg(Buffer.concat([Buffer.from(HDR, 'latin1'), pkt])));
  parts.push(Buffer.from([0xff, 0xd9]));
  return Uint8Array.from(Buffer.concat(parts));
}

describe('cadText (the reference formatter)', () => {
  for (const c of golden.cases) {
    it(`matches the golden text: ${c.name || '(own settings)'}`, () => {
      expect(cadText(unhex(c.record), c.film, c.name)).toBe(c.text);
    });
  }
  it('lists every field of xmp-fields.json, in order, once', () => {
    const t = cadText(unhex(golden.cases[0].record), 1, 'X');
    const got = [...t.matchAll(/ cad:(\w+)="/g)].map((m) => m[1]);
    expect(got).toEqual(fields.fields.map((f) => f.name));
  });
});

describe('readCad', () => {
  for (const c of golden.cases) {
    it(`gives back the record, film and (replaced) name: ${c.name || '(own settings)'}`, () => {
      const r = readCad(packet(c.text).toString('utf8'));
      expect(Buffer.from(r.rec).toString('hex')).toBe(c.record);
      expect(r.film).toBe(c.film);
      expect(r.name).toBe(c.name.replace(/[&<>"'\u0080-￿]/g, '_').slice(0, 15));
    });
  }
  it('refuses an out-of-range value and names the field', () => {
    const bad = golden.cases[0].text.replace('cad:WbAB="1"', 'cad:WbAB="9"');
    expect(() => readCad(packet(bad).toString('utf8'))).toThrow(/WbAB/);
  });
  it('refuses a list with the wrong length and names the field', () => {
    const bad = golden.cases[0].text.replace('cad:Hue="0,0,0,1,0,0,0,0,0,0,0,0"', 'cad:Hue="1,2"');
    expect(() => readCad(packet(bad).toString('utf8'))).toThrow(/Hue/);
  });
  it('refuses a Version other than 1', () => {
    const bad = golden.cases[0].text.replace('cad:Version="1"', 'cad:Version="2"');
    expect(() => readCad(packet(bad).toString('utf8'))).toThrow(/Version/);
  });
  it('names a missing field', () => {
    const bad = golden.cases[0].text.replace(/ cad:Film="1"/, '');
    expect(() => readCad(packet(bad).toString('utf8'))).toThrow(/Film/);
  });
});

describe('lookFromPhoto', () => {
  it('rebuilds the look from a photo', () => {
    const r = lookFromPhoto(jpeg(packet(golden.cases[0].text)));
    expect(r.look.name).toBe('Portra 400');
    expect(r.film).toBe(1);
    expect(r.look.hue[3]).toBe(1);
    expect(r.look.wb).toEqual({ a_b: 1, g_m: -1 });
  });
  const plain = (e: unknown) => { expect(e).toBeInstanceOf(Error); expect((e as Error).message).not.toMatch(/undefined|NaN|\[object/); expect((e as Error).message.length).toBeGreaterThan(10); };
  const msg = (f: () => unknown) => { try { f(); } catch (e) { plain(e); return (e as Error).message; } throw new Error('did not throw'); };
  it('says so for a file that is not a JPEG', () => {
    expect(msg(() => lookFromPhoto(Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10])))).toMatch(/JPEG/i);
    expect(msg(() => lookFromPhoto(new Uint8Array(0)))).toMatch(/JPEG/i);
  });
  it('says so for a JPEG with no XMP', () => {
    expect(msg(() => lookFromPhoto(Uint8Array.from([0xff, 0xd8, 0xff, 0xd9])))).toMatch(/XMP/);
    expect(msg(() => lookFromPhoto(jpeg(null)))).toMatch(/XMP/);
  });
  it('says so for a packet with no Caduceus fields', () => {
    expect(msg(() => lookFromPhoto(jpeg(packet(''))))).toMatch(/Caduceus/);
    expect(msg(() => lookFromPhoto(jpeg(packet(' xmlns:cad="https://androidfanman.github.io/caduceus-om3/ns/1/"'))))).toMatch(/Caduceus/);
  });
  it('says so for a file cut off inside the packet', () => {
    const j = jpeg(packet(golden.cases[0].text));
    expect(msg(() => lookFromPhoto(j.subarray(0, j.length >> 1)))).toMatch(/XMP|Caduceus/);
  });
  it('says so for a packet cut off inside the Caduceus text', () => {
    const cut = packet(golden.cases[0].text.slice(0, 300));
    expect(msg(() => lookFromPhoto(jpeg(cut)))).toMatch(/cad:\w+ is missing/);
  });
  it('findXmp returns null when there is none', () => {
    expect(findXmp(jpeg(null))).toBeNull();
  });
});
