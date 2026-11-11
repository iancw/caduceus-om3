// Creative Dial UI test (emulator only; build with OM3_GAP_KIB=256). Tokens in TOK: dialN (flip the dial to group-5 bit N: 0 MONO, 1 COLOR, 2 plain, 3 ART, 4 Color Creator), key names (down, right, ok ...), keyxN (repeat), main+1 / sub-1, shot:NAME. Prints the GUI state, P+LIDX and the slots' byte +50. OUTD=DIR TOK='dial2 dial1 rightx6 downx13 rightx3 upx13 leftx2 dial2 dial3 shot:final' OM_WORKER_ENTRY=60a8f623 OM_EMU_MODEL=E147 node dial_ui.mjs EMU_DIR out-X/main.bin CARD.omsd (card: this build's GUIDES / LABELS + the release's LOOKS / TONES)
//   OM_EMU_MODEL=E147 node session_ed1.mjs EMU_DIR IMAGE CARD.omsd OUT.json SAVE.omsd 'tokens...'
// Tokens: s1 (half-press click), ok/down/info/... (key click), main+N / sub+N (dials), wait. After each token: STATE,
// the editor fields of P (marker, axis, dirty, status), slot 0..3 hue/light/flags, and the settings 928..975 + 2197.
const [EMU, IMAGE, CARD] = process.argv.slice(2);
const fs = await import('node:fs');
const { createHash } = await import('node:crypto');
const zlib = await import('node:zlib');
const { expandImage } = await import(EMU + '/src/fw/expand.mjs');
const { loadBlock } = await import(EMU + '/bin/run.mjs');
const { Player } = await import(EMU + '/src/lab/player.mjs');
const { PLAYER_PARSER } = await import(EMU + '/scenarios/session_replay.mjs');
const { cardFromImage, cardImage } = await import(EMU + '/src/lab/sdcard.mjs');
const { PlaySession } = await import(EMU + '/src/lab/play.mjs');
// om-emu builds without PlaySession.lab_created: the application's task allow-list takes the worker's entry directly
if (process.env.OM_WORKER_ENTRY) { const ca = await import(EMU + '/src/lab/camapp.mjs'); ca.CA_TASK_ENTRIES.push((parseInt(process.env.OM_WORKER_ENTRY, 16) - 0x10021020) >>> 0); }
const WORKER_ENTRY = process.env.OM_WORKER_ENTRY ? parseInt(process.env.OM_WORKER_ENTRY, 16) : 0;   // the lab names task entries by decoded address
const oldCreated = PlaySession.prototype.lab_created;
PlaySession.prototype.lab_created = function (lab) { oldCreated?.call(this, lab); if (WORKER_ENTRY) lab.lt.allow.add(WORKER_ENTRY - 0x10021020); };
const STATE = 0x62b4dd16, POOL = 0xa2852000, HMAX = 0xae81;
let c0 = cardFromImage(new Uint8Array(fs.readFileSync(CARD)));
const card = { open: () => c0, save: (x) => { c0 = x; } };
const rom = expandImage(new Uint8Array(fs.readFileSync(IMAGE)));
const env = { rom, resBlock: loadBlock(), createHash, card,
  deflate: (b, l) => new Uint8Array(zlib.deflateSync(b, { level: l })), inflate: (b) => new Uint8Array(zlib.inflateSync(b)) };
const pl = new Player({ ...PLAYER_PARSER, no_browser: true, idle: 'off', a15: 'on', out: '<out>', no_wait_on_error: true, device: 'tft' },
  { ...env, wallClock: () => performance.now() / 1000 });
pl.open_session();
const play = await import(EMU + '/src/lab/play.mjs');
const s = pl.session, lab = s.lab;
lab.sim.write(0xa32de590, new Uint8Array([0xff, 0x03, 0, 0])); lab.sim.write(0xa32de58c, new Uint8Array([0xe9, 0x02, 0, 0]));
s.idle_slice(lab.lab_time() + 1500e6); s.camapp.pump();
lab.sim.write(0x60369308, new Uint8Array([0x00, 0xf0, 0, 0]));
for (let i = 0; i < 20; i++) { s.idle_slice(lab.lab_time() + 500e6); s.camapp.pump(); const b = lab.sim.read(0x62b4dd16, 2); if ((b[0] | b[1] << 8) > 0) break; }
for (const k of (process.env.PRE||'').split(' ').filter(Boolean)) { s.key(k, 'down'); s.camapp.pump(); s.idle_slice(lab.lab_time() + 150e6); s.key(k, 'up'); s.camapp.pump(); s.idle_slice(lab.lab_time() + 1500e6); }

const { groups } = play.uiin_layout(rom);
groups.forEach((g, i) => console.log('group', i, 'bytes', g.bytes, 'bits', g.bits, 'entries', g.entries.length, 'codes', [...new Set(g.entries.map((e) => e[2].toString(16)))].join(',')));
const pos = [];
groups.forEach((g, gi) => g.entries.forEach(([b, bit, code, typ, pol]) => { if (code === 0x1909) pos.push([gi, b, bit, pol]); }));
console.log('creative dial positions [group,byte,bit,pol]:', JSON.stringify(pos));
console.log('image bytes', pos.map(([g]) => Buffer.from(s.images[g]).toString('hex')).join(' '));


const { Debugger } = await import(EMU + '/src/debug/debugger.mjs');
const dd = Debugger.attach(lab.sim, { lab });
lab.sim.write(0xa32de590, new Uint8Array([0xff, 0x03, 0, 0])); lab.sim.write(0x60369308, new Uint8Array([0x00, 0xf0, 0, 0]));
const grp5 = []; groups.forEach((g, gi) => g.entries.forEach(([b, bit, code, typ, pol]) => { if (code === 0x1906) grp5.push([gi, b, bit, pol]); }));
const seq = (process.env.ORDER || '3').split(',').map(Number);
const flip = (k) => { grp5.forEach(([g2, b2, bit2, pol2], j) => play.set_bit(s.images[g2], b2, bit2, j === k ? pol2 : 1 - pol2)); s.push_group(5); s.camapp.pump(); s.idle_slice(lab.lab_time() + 800e6); };

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

const rd = (a, n) => lab.sim.read(a >>> 0, n);
const u16 = (a) => { const b = rd(a, 2); return b[0] | b[1] << 8; };
const u8 = (a) => rd(a, 1)[0];

const lidx = () => { const st = u16(STATE); if (!(st >= 1)) return 'noP'; const P = POOL + st - 1; return [0, 1, 2, 3].map((k) => u8(P + 712 + k)).join(',') + ' slot50=' + [0, 1, 2, 3].map((k) => u8(P + 32 + 64 * k + 50)).join(','); };
console.log('start STATE', u16(STATE).toString(16), lidx());
const pressKey = (k) => { s.key(k, 'down'); s.camapp.pump(); s.idle_slice(lab.lab_time() + 150e6); s.key(k, 'up'); s.camapp.pump(); s.idle_slice(lab.lab_time() + 400e6); };
for (const tok of (process.env.TOK || '').split(' ').filter(Boolean)) {
  let m;
  if ((m = /^dial(\d)$/.exec(tok))) { flip(+m[1]); console.log(tok, lab.state_names.get(lab.state()) ?? lab.state(), lidx()); }
  else if ((m = /^shot:(.+)$/.exec(tok))) { shot(process.env.OUTD + '/' + m[1] + '.png'); }
  else if ((m = /^(\w+)x(\d+)$/.exec(tok))) { for (let i = 0; i < +m[2]; i++) pressKey(m[1]); console.log(tok, lab.state_names.get(lab.state()) ?? lab.state(), lidx()); }
  else if ((m = /^(main|sub)([+-]\d+)$/.exec(tok))) { s.dial_input(m[1], parseInt(m[2], 10)); s.camapp.pump(); s.idle_slice(lab.lab_time() + 400e6); console.log(tok, lidx()); }
  else { pressKey(tok); console.log(tok, lab.state_names.get(lab.state()) ?? lab.state(), lidx()); }
}
