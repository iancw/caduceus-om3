// Creative Dial probe (emulator only). OUTD=DIR OM_EMU_MODEL=E147 node dial_probe.mjs EMU_DIR MAIN_BLOCK CARD.omsd : lists UI_IN groups, flips the dial (group 5, code 0x1906) and the group 4 switch (0x1909), prints the GUI state and writes a screenshot per position.
const [EMU, IMAGE, CARD] = process.argv.slice(2);
const fs = await import('node:fs');
const { createHash } = await import('node:crypto');
const zlib = await import('node:zlib');
const { expandImage } = await import(EMU + '/src/fw/expand.mjs');
const { loadBlock } = await import(EMU + '/bin/run.mjs');
const { Player } = await import(EMU + '/src/lab/player.mjs');
const { PLAYER_PARSER } = await import(EMU + '/scenarios/session_replay.mjs');
const { cardFromImage } = await import(EMU + '/src/lab/sdcard.mjs');
const play = await import(EMU + '/src/lab/play.mjs');
let c0 = cardFromImage(new Uint8Array(fs.readFileSync(CARD)));
const card = { open: () => c0, save: (x) => { c0 = x; } };
const rom = expandImage(new Uint8Array(fs.readFileSync(IMAGE)));
const env = { rom, resBlock: loadBlock(), createHash, card,
  deflate: (b, l) => new Uint8Array(zlib.deflateSync(b, { level: l })), inflate: (b) => new Uint8Array(zlib.inflateSync(b)) };
const pl = new Player({ ...PLAYER_PARSER, no_browser: true, idle: 'off', a15: 'on', out: '<out>', no_wait_on_error: true, device: 'tft' },
  { ...env, wallClock: () => performance.now() / 1000 });
pl.open_session();
const s = pl.session, lab = s.lab;
s.idle_slice(lab.lab_time() + 1500e6);
const { groups } = play.uiin_layout(rom);
groups.forEach((g, i) => console.log('group', i, 'bytes', g.bytes, 'bits', g.bits, 'entries', g.entries.length, 'codes', [...new Set(g.entries.map((e) => e[2].toString(16)))].join(',')));
const pos = [];
groups.forEach((g, gi) => g.entries.forEach(([b, bit, code, typ, pol]) => { if (code === 0x1909) pos.push([gi, b, bit, pol]); }));
console.log('creative dial positions [group,byte,bit,pol]:', JSON.stringify(pos));
console.log('image bytes', pos.map(([g]) => Buffer.from(s.images[g]).toString('hex')).join(' '));

const shot = (file) => {
  s.scene_frame(); s.a15_apply('tft'); const comp = lab.compose('tft', true, true); const w = comp.header.width, h = comp.header.height, px = comp.raw; const bpp = px.length / (w * h);
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w * 3 + 1)] = 0; for (let x = 0; x < w; x++) { const i = (y * w + x) * bpp, o = y * (w * 3 + 1) + 1 + x * 3; raw[o] = px[i + 2]; raw[o + 1] = px[i + 1]; raw[o + 2] = px[i]; } }
  const crcT = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crcT[n] = c >>> 0; }
  const crc = (b) => { let c = 0xffffffff; for (const x of b) c = crcT[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (ty, d) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(ty), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); };
  const ih = Buffer.alloc(13); ih.writeUInt32BE(w, 0); ih.writeUInt32BE(h, 4); ih[8] = 8; ih[2 + 7] = 2;
  fs.writeFileSync(file, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ih), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]));
};
const OUTD = process.env.OUTD;
shot(OUTD + '/idle.png');
console.log('gui', lab.state_names.get(lab.state()) ?? lab.state());
const grp5 = []; groups.forEach((g, gi) => g.entries.forEach(([b, bit, code, typ, pol]) => { if (code === 0x1906) grp5.push([gi, b, bit, pol, typ]); }));
console.log('group5 entries', JSON.stringify(grp5), 'image', Buffer.from(s.images[5]).toString('hex'));
const test = (name, list) => {
  const [g] = list[0];
  for (const [gg, b, bit, pol] of list) play.set_bit(s.images[gg], b, bit, 1 - pol);
  return g;
};
for (const [label, list] of [['cd', pos], ['g5', grp5]]) {
  const g = list[0][0];
  list.forEach(([gg, b, bit, pol], k) => {
    list.forEach(([g2, b2, bit2, pol2], j) => play.set_bit(s.images[g2], b2, bit2, j === k ? pol2 : 1 - pol2));
    const r = s.push_group(g); s.camapp.pump(); s.idle_slice(lab.lab_time() + 800e6);
    console.log(label, 'pos', k, 'push', JSON.stringify(r), 'gui', lab.state_names.get(lab.state()) ?? lab.state());
    shot(OUTD + '/' + label + k + '.png');
  });
}
